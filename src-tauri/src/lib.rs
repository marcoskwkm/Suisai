mod ai;
mod cli;
mod source;

use source::{DiffOutput, FileContent, SessionInfo, Side, Source};
use std::path::{Path, PathBuf};
use tauri::{Manager, RunEvent};

struct AppState {
    info: SessionInfo,
    source: Option<Source>,
    temp_dir: PathBuf,
    /// Identifies this diff (repo + arguments, or the compared paths) for the guide cache.
    cache_key: String,
    /// Where AI agents run: the repo root, or the right-hand directory.
    work_dir: PathBuf,
}

#[tauri::command]
fn get_session(state: tauri::State<'_, AppState>) -> SessionInfo {
    state.info.clone()
}

#[tauri::command]
async fn get_diff(state: tauri::State<'_, AppState>, ignore_whitespace: bool) -> Result<DiffOutput, String> {
    match &state.source {
        Some(source) => source.diff(ignore_whitespace),
        None => Err(state.info.error.clone().unwrap_or_default()),
    }
}

#[tauri::command]
async fn read_file(
    state: tauri::State<'_, AppState>,
    side: Side,
    path: String,
    blob: Option<String>,
    base64: bool,
) -> Result<FileContent, String> {
    match &state.source {
        Some(source) => Ok(source.read(side, &path, blob.as_deref(), base64)),
        None => Ok(FileContent::Missing),
    }
}

/// Absolute path of the file to open in an editor, or null if there is none.
#[tauri::command]
fn editor_target(state: tauri::State<'_, AppState>, path: String) -> Option<String> {
    let target = state.source.as_ref()?.editor_target(&path)?;
    Some(target.to_string_lossy().into_owned())
}

#[tauri::command]
async fn open_in_editor(state: tauri::State<'_, AppState>, path: String, line: u32) -> Result<(), String> {
    match &state.source {
        Some(source) => source.open_in_editor(&path, line),
        None => Err("nothing to open".into()),
    }
}

#[tauri::command]
async fn ai_agents() -> Vec<ai::AgentInfo> {
    tauri::async_runtime::spawn_blocking(ai::detect_agents).await.unwrap_or_default()
}

#[tauri::command]
async fn ai_run(
    state: tauri::State<'_, AppState>,
    agent: ai::AgentKind,
    model: Option<String>,
    prompt: String,
    schema: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let cwd = state.work_dir.clone();
    tauri::async_runtime::spawn_blocking(move || ai::run(agent, model.as_deref(), &cwd, &prompt, &schema))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn ai_cancel() {
    ai::cancel();
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn guide_load(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Option<String> {
    ai::load_guide(&cache_dir(&app).ok()?, &state.cache_key)
}

#[tauri::command]
fn guide_save(app: tauri::AppHandle, state: tauri::State<'_, AppState>, data: Option<String>) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    match data {
        Some(d) => ai::save_guide(&dir, &state.cache_key, &d),
        None => {
            ai::delete_guide(&dir, &state.cache_key);
            Ok(())
        }
    }
}

#[tauri::command]
fn settings_load(app: tauri::AppHandle) -> Option<String> {
    ai::load_settings(&app.path().app_config_dir().ok()?)
}

#[tauri::command]
fn settings_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    ai::save_settings(&app.path().app_config_dir().map_err(|e| e.to_string())?, &data)
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

fn canonical(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// Cache key and agent working directory for a session.
fn guide_context(source: Option<&Source>, cwd: &Path) -> (String, PathBuf) {
    match source {
        Some(Source::Repo { root, args, .. }) => (format!("repo\0{}\0{}", root.display(), args.join("\0")), root.clone()),
        Some(Source::Paths { right_original, .. }) => {
            let in_difftool = right_original.to_string_lossy().contains("git-difftool.");
            let dir = if right_original.is_dir() { right_original.clone() } else { right_original.parent().unwrap_or(cwd).to_path_buf() };
            match source::git_root(cwd) {
                // difftool's temp dirs change on every run: key on the repo instead.
                Ok(root) if in_difftool || !right_original.starts_with(&root) => (format!("difftool\0{}", root.display()), root),
                _ => (format!("paths\0{}", right_original.display()), dir),
            }
        }
        None => (String::new(), cwd.to_path_buf()),
    }
}

fn build_session(inv: cli::Invocation, temp_dir: &Path) -> (SessionInfo, Option<Source>) {
    let mut info = SessionInfo {
        title: "Suisai".into(),
        subtitle: String::new(),
        mode: "repo",
        left_root: None,
        right_root: None,
        file_name: None,
        error: None,
    };
    match inv.command {
        cli::Command::Repo { args } => match source::git_root(&inv.cwd) {
            Ok(root) => {
                info.title = file_name(&root);
                info.subtitle = std::iter::once("git diff".to_string()).chain(args.iter().cloned()).collect::<Vec<_>>().join(" ");
                (info, Some(Source::Repo { cwd: inv.cwd, root, args }))
            }
            Err(e) => {
                info.error = Some(e);
                (info, None)
            }
        },
        cli::Command::Paths { left, right } => {
            info.mode = "paths";
            let (left, right) = (canonical(&left), canonical(&right));
            let single = left.is_file();
            // `git difftool -d` uses git-difftool.* temp dirs; per-file mode sets these variables.
            let counter = std::env::var("GIT_DIFF_PATH_COUNTER").ok();
            let total = std::env::var("GIT_DIFF_PATH_TOTAL").ok();
            let is_difftool = left.to_string_lossy().contains("git-difftool.") || total.is_some();
            if is_difftool {
                info.title = source::git_root(&inv.cwd).map(|r| file_name(&r)).unwrap_or_else(|_| "Suisai".into());
                info.subtitle = match (counter, total) {
                    (Some(c), Some(t)) if t != "1" => format!("git difftool · file {c} of {t}"),
                    _ => "git difftool".into(),
                };
            } else {
                info.title = format!("{} ↔ {}", file_name(&left), file_name(&right));
                info.subtitle = format!("{} ↔ {}", left.display(), right.display());
            }
            // With single files, difftool passes a temp copy as LOCAL and the
            // working tree file (when applicable) as REMOTE: name it after REMOTE.
            let display_name = single.then(|| {
                right
                    .strip_prefix(canonical(&inv.cwd))
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| file_name(&right))
            });
            let right_original = right.clone();
            let resolved = source::resolve_symlinks(&left, temp_dir, "left")
                .and_then(|l| source::resolve_symlinks(&right, temp_dir, "right").map(|r| (l, r)));
            match resolved {
                Ok((left, right)) => {
                    info.left_root = Some(left.to_string_lossy().into_owned());
                    info.right_root = Some(right.to_string_lossy().into_owned());
                    info.file_name = display_name.clone();
                    (info, Some(Source::Paths { left, right, file_name: display_name, right_original }))
                }
                Err(e) => {
                    info.error = Some(format!("could not read files: {e}"));
                    (info, None)
                }
            }
        }
        cli::Command::Help | cli::Command::Version => unreachable!(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let invocation = match cli::parse(std::env::args().skip(1), &cwd) {
        Ok(inv) => inv,
        Err(e) => {
            eprintln!("ss: {e}");
            std::process::exit(2);
        }
    };
    match invocation.command {
        cli::Command::Help => {
            print!("{}", cli::USAGE);
            return;
        }
        cli::Command::Version => {
            println!("suisai {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {}
    }

    let temp_dir = std::env::temp_dir().join(format!("suisai-{}", std::process::id()));
    let cwd_for_guide = invocation.cwd.clone();
    let (info, source) = build_session(invocation, &temp_dir);
    let (cache_key, work_dir) = guide_context(source.as_ref(), &cwd_for_guide);
    let title = if info.subtitle.is_empty() { info.title.clone() } else { format!("{} — {}", info.title, info.subtitle) };

    let app = tauri::Builder::default()
        .manage(AppState { info, source, temp_dir, cache_key, work_dir })
        .invoke_handler(tauri::generate_handler![
            get_session,
            get_diff,
            read_file,
            editor_target,
            open_in_editor,
            ai_agents,
            ai_run,
            ai_cancel,
            guide_load,
            guide_save,
            settings_load,
            settings_save
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&title);
                let _ = window.set_focus();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            ai::cancel();
            let dir = &handle.state::<AppState>().temp_dir;
            let _ = std::fs::remove_dir_all(dir);
        }
    });
}
