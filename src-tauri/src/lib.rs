mod cli;
mod source;

use source::{DiffOutput, FileContent, SessionInfo, Side, Source};
use std::path::{Path, PathBuf};
use tauri::{Manager, RunEvent};

struct AppState {
    info: SessionInfo,
    source: Option<Source>,
    temp_dir: PathBuf,
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

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

fn canonical(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
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
            let resolved = source::resolve_symlinks(&left, temp_dir, "left")
                .and_then(|l| source::resolve_symlinks(&right, temp_dir, "right").map(|r| (l, r)));
            match resolved {
                Ok((left, right)) => {
                    info.left_root = Some(left.to_string_lossy().into_owned());
                    info.right_root = Some(right.to_string_lossy().into_owned());
                    info.file_name = display_name.clone();
                    (info, Some(Source::Paths { left, right, file_name: display_name }))
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
    let (info, source) = build_session(invocation, &temp_dir);
    let title = if info.subtitle.is_empty() { info.title.clone() } else { format!("{} — {}", info.title, info.subtitle) };

    let app = tauri::Builder::default()
        .manage(AppState { info, source, temp_dir })
        .invoke_handler(tauri::generate_handler![get_session, get_diff, read_file])
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
            let dir = &handle.state::<AppState>().temp_dir;
            let _ = std::fs::remove_dir_all(dir);
        }
    });
}
