//! Where a diff comes from (a git repo or two paths on disk), how to run
//! `git diff` for it, and how to read the full "before" and "after" files.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

/// Text files larger than this are not sent to the UI in full.
const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// Binary files larger than this are not sent as base64 (for image previews).
const MAX_BINARY_BYTES: u64 = 20 * 1024 * 1024;

pub enum Source {
    Repo {
        cwd: PathBuf,
        root: PathBuf,
        args: Vec<String>,
    },
    Paths {
        /// Roots that git actually compares (symlink-free copies if needed).
        left: PathBuf,
        right: PathBuf,
        /// Name to show when comparing two single files.
        file_name: Option<String>,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub title: String,
    pub subtitle: String,
    pub mode: &'static str,
    /// Paths mode: prefixes to strip from the paths in git's output.
    pub left_root: Option<String>,
    pub right_root: Option<String>,
    pub file_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Old,
    New,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileContent {
    Text { text: String },
    Binary { size: u64, base64: Option<String> },
    TooLarge { size: u64 },
    Missing,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOutput {
    /// Patch with all changes. Defines the file list.
    pub patch: String,
    /// Patch generated with `-w`, when whitespace changes are hidden.
    pub ignore_whitespace_patch: Option<String>,
}

pub fn git_root(cwd: &Path) -> Result<PathBuf, String> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(format!("not a git repository: {}", cwd.display()));
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
}

/// Flags that make git's output predictable regardless of the user's config.
fn base_diff_command(cwd: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .args(["-c", "core.quotepath=false"])
        .args(["-c", "diff.noprefix=false"])
        .args(["-c", "diff.mnemonicPrefix=false"])
        .args(["-c", "diff.relative=false"])
        .arg("diff")
        .args([
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--full-index",
            "-M",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ]);
    cmd
}

fn run(mut cmd: Command, allow_exit_one: bool) -> Result<String, String> {
    let out = cmd.output().map_err(|e| format!("could not run git: {e}"))?;
    let code = out.status.code().unwrap_or(-1);
    if out.status.success() || (allow_exit_one && code == 1) {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

impl Source {
    pub fn diff(&self, ignore_whitespace: bool) -> Result<DiffOutput, String> {
        let make = |ws: bool| -> Command {
            match self {
                Source::Repo { cwd, args, .. } => {
                    let mut cmd = base_diff_command(cwd);
                    if ws {
                        cmd.arg("-w");
                    }
                    cmd.args(args);
                    cmd
                }
                Source::Paths { left, right, .. } => {
                    let mut cmd = base_diff_command(left.parent().unwrap_or(Path::new("/")));
                    cmd.arg("--no-index");
                    if ws {
                        cmd.arg("-w");
                    }
                    cmd.arg("--").arg(left).arg(right);
                    cmd
                }
            }
        };
        // `git diff --no-index` exits with 1 when there are differences.
        let no_index = matches!(self, Source::Paths { .. });
        let patch = run(make(false), no_index)?;
        let ignore_whitespace_patch =
            if ignore_whitespace { Some(run(make(true), no_index)?) } else { None };
        Ok(DiffOutput { patch, ignore_whitespace_patch })
    }

    pub fn read(&self, side: Side, path: &str, blob: Option<&str>, want_base64: bool) -> FileContent {
        let bytes = match self {
            Source::Repo { root, .. } => read_repo_file(root, path, blob),
            Source::Paths { left, right, file_name } => {
                let root = if side == Side::Old { left } else { right };
                if file_name.is_some() {
                    read_limited(root)
                } else {
                    match safe_join(root, path) {
                        Some(p) => read_limited(&p),
                        None => Ok(None),
                    }
                }
            }
        };
        match bytes {
            Ok(Some(Loaded::Bytes(bytes))) => classify(bytes, want_base64),
            Ok(Some(Loaded::TooLarge(size))) => FileContent::TooLarge { size },
            _ => FileContent::Missing,
        }
    }
}

enum Loaded {
    Bytes(Vec<u8>),
    TooLarge(u64),
}

fn classify(bytes: Vec<u8>, want_base64: bool) -> FileContent {
    let size = bytes.len() as u64;
    let sample = &bytes[..bytes.len().min(8000)];
    if sample.contains(&0) {
        let base64 = (want_base64 && size <= MAX_BINARY_BYTES)
            .then(|| base64::engine::general_purpose::STANDARD.encode(&bytes));
        return FileContent::Binary { size, base64 };
    }
    if size > MAX_TEXT_BYTES {
        return FileContent::TooLarge { size };
    }
    if want_base64 {
        // e.g. SVG images, which are text but previewed as images.
        let base64 = Some(base64::engine::general_purpose::STANDARD.encode(&bytes));
        return FileContent::Binary { size, base64 };
    }
    FileContent::Text { text: String::from_utf8_lossy(&bytes).into_owned() }
}

fn read_limited(path: &Path) -> io::Result<Option<Loaded>> {
    let meta = match fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        _ => return Ok(None),
    };
    if meta.len() > MAX_BINARY_BYTES.max(MAX_TEXT_BYTES) {
        return Ok(Some(Loaded::TooLarge(meta.len())));
    }
    fs::read(path).map(|b| Some(Loaded::Bytes(b)))
}

fn read_repo_file(root: &Path, path: &str, blob: Option<&str>) -> io::Result<Option<Loaded>> {
    if let Some(sha) = blob.filter(|s| !s.is_empty() && !s.bytes().all(|b| b == b'0')) {
        let out = Command::new("git")
            .args(["cat-file", "blob", sha])
            .current_dir(root)
            .output()?;
        if out.status.success() {
            return Ok(Some(Loaded::Bytes(out.stdout)));
        }
        // Not in the object database: this side is the working tree.
    } else if blob.is_some() {
        // All-zero id: the file does not exist on this side.
        return Ok(None);
    }
    match safe_join(root, path) {
        Some(p) => read_limited(&p),
        None => Ok(None),
    }
}

/// Joins a relative path onto a root, refusing anything that escapes it.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(root.join(rel))
}

/// `git difftool -d` fills the right-hand directory with symlinks into the
/// working tree, and `git diff --no-index` compares symlinks as links rather
/// than following them. If a tree contains symlinks, copy it with links resolved.
pub fn resolve_symlinks(root: &Path, temp: &Path, name: &str) -> io::Result<PathBuf> {
    if !contains_symlink(root, 0)? {
        return Ok(root.to_path_buf());
    }
    let dest = temp.join(name);
    if root.is_dir() {
        copy_resolved(root, &dest, 0)?;
    } else {
        fs::create_dir_all(temp)?;
        fs::copy(root, &dest)?;
    }
    Ok(dest)
}

fn contains_symlink(path: &Path, depth: usize) -> io::Result<bool> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Ok(true);
    }
    if meta.is_dir() && depth < 64 {
        for entry in fs::read_dir(path)? {
            if contains_symlink(&entry?.path(), depth + 1)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn copy_resolved(src: &Path, dest: &Path, depth: usize) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        match fs::metadata(&from) {
            Ok(m) if m.is_dir() && depth < 64 => copy_resolved(&from, &to, depth + 1)?,
            Ok(m) if m.is_file() => {
                fs::copy(&from, &to)?;
            }
            // Broken symlink: keep the link text so it still shows up in the diff.
            _ => {
                if let Ok(target) = fs::read_link(&from) {
                    fs::write(&to, target.to_string_lossy().as_bytes())?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_rejects_escapes() {
        let root = Path::new("/r");
        assert_eq!(safe_join(root, "a/b.txt"), Some(PathBuf::from("/r/a/b.txt")));
        assert_eq!(safe_join(root, "../x"), None);
        assert_eq!(safe_join(root, "/etc/passwd"), None);
    }

    #[test]
    fn resolves_symlinked_trees() {
        let base = std::env::temp_dir().join(format!("suisai-src-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("tree/sub")).unwrap();
        fs::write(base.join("real.txt"), "content").unwrap();
        std::os::unix::fs::symlink(base.join("real.txt"), base.join("tree/sub/link.txt")).unwrap();

        let out = resolve_symlinks(&base.join("tree"), &base.join("tmp"), "right").unwrap();
        assert_eq!(out, base.join("tmp/right"));
        let copied = out.join("sub/link.txt");
        assert!(!fs::symlink_metadata(&copied).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(copied).unwrap(), "content");

        fs::write(base.join("plain.txt"), "x").unwrap();
        assert_eq!(resolve_symlinks(&base.join("plain.txt"), &base.join("tmp"), "l").unwrap(), base.join("plain.txt"));
        fs::remove_dir_all(&base).unwrap();
    }
}
