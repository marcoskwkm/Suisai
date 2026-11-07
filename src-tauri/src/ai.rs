//! Runs a local AI agent CLI (Claude Code or Codex) to write review guides,
//! and caches the guides on disk.
//!
//! The agents run headless in the repository with read-only tools, take the
//! prompt on stdin and answer with JSON matching a schema.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Agents give up after this long.
const TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    const ALL: [AgentKind; 2] = [AgentKind::Claude, AgentKind::Codex];

    fn binary(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub kind: AgentKind,
    /// Where the CLI was found, if it is installed.
    pub path: Option<String>,
}

/// Finds the installed agent CLIs. Cached: the search can start a login shell.
pub fn detect_agents() -> Vec<AgentInfo> {
    static FOUND: OnceLock<Vec<AgentInfo>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            AgentKind::ALL
                .iter()
                .map(|&kind| AgentInfo { kind, path: find_binary(kind.binary()).map(|p| p.to_string_lossy().into_owned()) })
                .collect()
        })
        .clone()
}

fn agent_path(kind: AgentKind) -> Result<PathBuf, String> {
    detect_agents()
        .into_iter()
        .find(|a| a.kind == kind)
        .and_then(|a| a.path)
        .map(PathBuf::from)
        .ok_or_else(|| format!("`{}` is not installed", kind.binary()))
}

/// Looks for a command on PATH, in common install locations, and finally in
/// the user's login shell (apps opened from Finder get a minimal PATH).
fn find_binary(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(h) = &home {
        for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", ".cargo/bin"] {
            dirs.push(h.join(d));
        }
    }
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    if let Some(p) = dirs.iter().map(|d| d.join(name)).find(|p| is_executable(p)) {
        return Some(p);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell).args(["-l", "-c", &format!("command -v {name}")]).stdin(Stdio::null()).output().ok()?;
    let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).lines().last()?.trim());
    (out.status.success() && is_executable(&p)).then_some(p)
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

// ---- running ----

/// The agent process that is running, so it can be cancelled.
static RUNNING: Mutex<Option<(u64, Child)>> = Mutex::new(None);
static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

/// Stops the running agent, if any.
pub fn cancel() {
    if let Some((_, mut child)) = RUNNING.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Runs the agent with a prompt and returns the JSON value it produced.
/// Only one agent runs at a time: starting one cancels the previous one.
pub fn run(kind: AgentKind, model: Option<&str>, cwd: &Path, prompt: &str, schema: &serde_json::Value) -> Result<serde_json::Value, String> {
    let exe = agent_path(kind)?;
    let scratch = std::env::temp_dir().join(format!("suisai-ai-{}-{}", std::process::id(), NEXT_RUN.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut cmd = Command::new(&exe);
        cmd.current_dir(cwd);
        // Lets Claude Code start even when Suisai was opened from inside a Claude Code session.
        cmd.env_remove("CLAUDECODE");
        let model = model.map(str::trim).filter(|m| !m.is_empty());
        let out_file = scratch.join("answer.json");
        match kind {
            AgentKind::Claude => {
                cmd.args(["-p", "--output-format", "json", "--no-session-persistence"])
                    .args(["--tools", "Read,Grep,Glob"])
                    .arg("--json-schema")
                    .arg(schema.to_string());
                if let Some(m) = model {
                    cmd.args(["--model", m]);
                }
            }
            AgentKind::Codex => {
                let schema_file = scratch.join("schema.json");
                std::fs::write(&schema_file, schema.to_string()).map_err(|e| e.to_string())?;
                cmd.args(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never"])
                    .arg("--output-schema")
                    .arg(&schema_file)
                    .arg("--output-last-message")
                    .arg(&out_file);
                if let Some(m) = model {
                    cmd.args(["--model", m]);
                }
                cmd.arg("-");
            }
        }
        let (stdout, stderr) = run_process(cmd, prompt)?;
        match kind {
            AgentKind::Claude => parse_claude(&stdout, &stderr),
            AgentKind::Codex => {
                let text = std::fs::read_to_string(&out_file).map_err(|_| failure("Codex", &stderr, &stdout))?;
                parse_json_text(&text).ok_or_else(|| format!("Codex did not answer with JSON: {}", excerpt(&text)))
            }
        }
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// Starts a process, writes `input` to its stdin and waits for it to exit.
fn run_process(mut cmd: Command, input: &str) -> Result<(String, String), String> {
    cancel();
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the agent: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let input = input.to_string();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let read_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let read_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let id = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
    *RUNNING.lock().unwrap() = Some((id, child));
    let started = Instant::now();
    let status = loop {
        {
            let mut running = RUNNING.lock().unwrap();
            match running.as_mut() {
                Some((rid, child)) if *rid == id => {
                    if let Ok(Some(status)) = child.try_wait() {
                        running.take();
                        break Some(status);
                    }
                    if started.elapsed() > TIMEOUT {
                        let _ = child.kill();
                        let _ = child.wait();
                        running.take();
                        return Err("the agent took too long and was stopped".into());
                    }
                }
                // Cancelled, or replaced by a newer run.
                _ => break None,
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = writer.join();
    let out = read_out.join().unwrap_or_default();
    let err = read_err.join().unwrap_or_default();
    let Some(status) = status else { return Err("cancelled".into()) };
    if !status.success() && out.trim().is_empty() {
        return Err(failure("The agent", &err, &out));
    }
    Ok((out, err))
}

fn failure(who: &str, stderr: &str, stdout: &str) -> String {
    let msg = if stderr.trim().is_empty() { stdout } else { stderr };
    format!("{who} failed: {}", excerpt(msg))
}

fn excerpt(s: &str) -> String {
    let s = s.trim();
    let tail: String = s.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
    if tail.len() < s.len() { format!("…{tail}") } else { tail }
}

/// Claude Code's `--output-format json` result: the answer is in
/// `structured_output` (or, failing that, `result` as text).
fn parse_claude(stdout: &str, stderr: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str(l).ok())
        .or_else(|| serde_json::from_str(stdout).ok())
        .ok_or_else(|| failure("Claude Code", stderr, stdout))?;
    if v.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
        let msg = v.get("result").and_then(|r| r.as_str()).unwrap_or("unknown error");
        return Err(format!("Claude Code failed: {}", excerpt(msg)));
    }
    if let Some(s) = v.get("structured_output").filter(|s| s.is_object()) {
        return Ok(s.clone());
    }
    let text = v.get("result").and_then(|r| r.as_str()).unwrap_or_default();
    parse_json_text(text).ok_or_else(|| format!("Claude Code did not answer with JSON: {}", excerpt(text)))
}

/// Parses JSON from a reply, tolerating a Markdown code fence around it.
fn parse_json_text(text: &str) -> Option<serde_json::Value> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str(t) {
        return Some(v);
    }
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    serde_json::from_str(&t[start..=end]).ok()
}

// ---- cache ----

/// Small, stable hash for cache file names.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn cache_file(dir: &Path, key: &str) -> PathBuf {
    dir.join("guides").join(format!("{:016x}.json", fnv1a(key)))
}

pub fn load_guide(dir: &Path, key: &str) -> Option<String> {
    std::fs::read_to_string(cache_file(dir, key)).ok()
}

pub fn save_guide(dir: &Path, key: &str, data: &str) -> Result<(), String> {
    let file = cache_file(dir, key);
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    // Write then rename, so a crash never leaves half a file.
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// The agent settings, shared by every Suisai window (the built app and dev mode).
pub fn load_settings(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join("settings.json")).ok()
}

pub fn save_settings(dir: &Path, data: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join("settings.json");
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

pub fn delete_guide(dir: &Path, key: &str) {
    let _ = std::fs::remove_file(cache_file(dir, key));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_results() {
        let ok = r#"{"type":"result","is_error":false,"result":"{\"a\":1}","structured_output":{"a":1}}"#;
        assert_eq!(parse_claude(ok, "").unwrap(), serde_json::json!({"a": 1}));
        let text_only = r#"{"type":"result","is_error":false,"result":"```json\n{\"a\":2}\n```"}"#;
        assert_eq!(parse_claude(text_only, "").unwrap(), serde_json::json!({"a": 2}));
        let err = r#"{"type":"result","is_error":true,"result":"Not logged in"}"#;
        assert!(parse_claude(err, "").unwrap_err().contains("Not logged in"));
    }

    #[test]
    fn cache_names_are_stable() {
        assert_eq!(fnv1a(""), 0xcbf29ce484222325);
        assert_ne!(fnv1a("a"), fnv1a("b"));
    }
}
