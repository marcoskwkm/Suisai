//! Command-line parsing.
//!
//! Usage:
//!   ss [-C <dir>] [-g] [<git diff args>...]   compare using `git diff` in the current repo
//!   ss [-C <dir>] [-g] <left> <right>         compare two existing files or directories
//!                                                  (this is what `git difftool` calls)

use std::path::{Path, PathBuf};

pub const USAGE: &str = "\
Suisai: a GitHub-style diff viewer for git.

Usage:
  ss [-C <dir>] [-g] [<git diff args>...]
      Show `git diff <args>` for the repository in the current directory.
      Examples: ss | ss --staged | ss HEAD~3 | ss main...feature -- src/

  ss [-C <dir>] [-g] <left> <right>
      Compare two files or directories (used by `git difftool`).
      If both arguments exist on disk they are treated as paths; use
      `ss -- <path> <path>` to pass them to git diff as pathspecs instead.

Options:
  -C <dir>        Run as if started in <dir>
  -g, --guide     Open the AI review guide, and write it if there is none
                  for this diff yet (asks to connect an agent if needed)
  -h, --help      Show this help
  -V, --version   Show version

Use as git's difftool:
  git config --global diff.tool suisai
  git config --global difftool.suisai.cmd 'ss \"$LOCAL\" \"$REMOTE\"'
  git config --global difftool.prompt false
  git difftool -d [<commit>...]
";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    Repo { args: Vec<String> },
    Paths { left: PathBuf, right: PathBuf },
}

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub cwd: PathBuf,
    pub command: Command,
    /// `--guide`: open the review guide and generate it if needed.
    pub guide: bool,
}

pub fn parse(raw: impl IntoIterator<Item = String>, cwd: &Path) -> Result<Invocation, String> {
    // Old macOS versions pass a `-psn_*` process serial number when launched from Finder.
    let mut args: Vec<String> = raw.into_iter().filter(|a| !a.starts_with("-psn_")).collect();
    let mut cwd = cwd.to_path_buf();
    let mut guide = false;

    // Suisai's own options come first (like git's `-C <dir>`); the rest is
    // for `git diff`, or the two paths to compare.
    loop {
        match args.first().map(String::as_str) {
            Some("-C") => {
                if args.len() < 2 {
                    return Err("option -C requires a directory".into());
                }
                let dir = args.remove(1);
                args.remove(0);
                cwd = cwd.join(dir);
            }
            Some("--guide" | "-g") => {
                args.remove(0);
                guide = true;
            }
            _ => break,
        }
    }
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }

    if args.len() == 1 {
        match args[0].as_str() {
            "-h" | "--help" => return Ok(Invocation { cwd, command: Command::Help, guide }),
            "-V" | "--version" => return Ok(Invocation { cwd, command: Command::Version, guide }),
            _ => {}
        }
    }

    if args.len() == 2 && args.iter().all(|a| !a.starts_with('-')) {
        let left = cwd.join(&args[0]);
        let right = cwd.join(&args[1]);
        if left.exists() && right.exists() {
            if left.is_dir() != right.is_dir() {
                return Err("cannot compare a file with a directory".into());
            }
            return Ok(Invocation { cwd, command: Command::Paths { left, right }, guide });
        }
    }

    Ok(Invocation { cwd, command: Command::Repo { args }, guide })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    /// A scratch directory with two dirs and two files, removed when dropped.
    struct Scratch(PathBuf);

    impl std::ops::Deref for Scratch {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp() -> Scratch {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir()
            .join(format!("suisai-cli-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("f1"), "x").unwrap();
        std::fs::write(dir.join("f2"), "y").unwrap();
        Scratch(dir)
    }

    #[test]
    fn no_args_is_repo_mode() {
        let d = tmp();
        assert_eq!(parse(s(&[]), &d).unwrap().command, Command::Repo { args: vec![] });
    }

    #[test]
    fn revisions_are_repo_mode() {
        let d = tmp();
        let inv = parse(s(&["HEAD~1", "HEAD"]), &d).unwrap();
        assert_eq!(inv.command, Command::Repo { args: s(&["HEAD~1", "HEAD"]) });
    }

    #[test]
    fn two_existing_paths_are_paths_mode() {
        let d = tmp();
        let inv = parse(s(&["a", "b"]), &d).unwrap();
        assert_eq!(inv.command, Command::Paths { left: d.join("a"), right: d.join("b") });
        let inv = parse(s(&["f1", "f2"]), &d).unwrap();
        assert!(matches!(inv.command, Command::Paths { .. }));
    }

    #[test]
    fn file_vs_dir_is_an_error() {
        let d = tmp();
        assert!(parse(s(&["a", "f1"]), &d).is_err());
    }

    #[test]
    fn double_dash_forces_repo_mode() {
        let d = tmp();
        let inv = parse(s(&["--", "f1"]), &d).unwrap();
        assert_eq!(inv.command, Command::Repo { args: s(&["--", "f1"]) });
    }

    #[test]
    fn dash_c_changes_cwd() {
        let d = tmp();
        let inv = parse(s(&["-C", d.to_str().unwrap(), "--staged"]), Path::new("/")).unwrap();
        assert_eq!(inv.cwd, d.to_path_buf());
        assert_eq!(inv.command, Command::Repo { args: s(&["--staged"]) });
    }

    #[test]
    fn guide_flag() {
        let d = tmp();
        let inv = parse(s(&["--guide", "--staged"]), &d).unwrap();
        assert!(inv.guide);
        assert_eq!(inv.command, Command::Repo { args: s(&["--staged"]) });
        // Mixed with -C, in any order; still paths mode for two paths.
        let inv = parse(s(&["-C", d.to_str().unwrap(), "--guide", "a", "b"]), Path::new("/")).unwrap();
        assert!(inv.guide);
        assert!(matches!(inv.command, Command::Paths { .. }));
        let inv = parse(s(&["--guide", "-C", d.to_str().unwrap()]), Path::new("/")).unwrap();
        assert!(inv.guide);
        // Only leading options count: after `--` it is a pathspec.
        let inv = parse(s(&["--", "--guide"]), &d).unwrap();
        assert!(!inv.guide);
        assert_eq!(inv.command, Command::Repo { args: s(&["--", "--guide"]) });
        assert!(!parse(s(&["HEAD"]), &d).unwrap().guide);
        let inv = parse(s(&["-g", "HEAD~1"]), &d).unwrap();
        assert!(inv.guide);
        assert_eq!(inv.command, Command::Repo { args: s(&["HEAD~1"]) });
    }

    #[test]
    fn help_and_version() {
        let d = tmp();
        assert_eq!(parse(s(&["--help"]), &d).unwrap().command, Command::Help);
        assert_eq!(parse(s(&["-V"]), &d).unwrap().command, Command::Version);
        assert_eq!(parse(s(&["-psn_0_123"]), &d).unwrap().command, Command::Repo { args: vec![] });
    }
}
