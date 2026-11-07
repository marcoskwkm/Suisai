# Suisai

A GitHub-style diff viewer for macOS that works with `git diff` and `git difftool`.

> *Suisai* (水彩) means "watercolor": what this app does to your diffs. The name comes from
> *水彩 〜aquaveil〜*, the first album of voice actress and singer [Itou Miku](https://en.wikipedia.org/wiki/Miku_It%C5%8D).

![Suisai showing a split diff of a TypeScript file, with the changed files in a tree on the left](docs/screenshot-light.png#gh-light-mode-only)
![Suisai showing a split diff of a TypeScript file, with the changed files in a tree on the left](docs/screenshot-dark.png#gh-dark-mode-only)

- File tree of changes on the left, diff on the right (like [diffview.nvim](https://github.com/sindrets/diffview.nvim))
- Split and unified views
- Syntax highlighting for 200+ languages ([Shiki](https://shiki.style), same grammars as VS Code)
- Word-level highlights inside changed lines
- Hide whitespace changes (like GitHub's `?w=1`)
- Wrap long lines
- Expand the unchanged lines between hunks
- Before/after previews for images
- Keyboard-driven (press <kbd>?</kbd> in the app)

## Usage

```sh
ss                          # unstaged changes (same as `git diff`)
ss --staged                 # staged changes
ss HEAD~3                   # any `git diff` arguments work
ss main...feature -- src/
ss left/ right/             # compare two directories or files
ss -C ~/code/project        # run as if started in another directory
ss -g HEAD~3                # open the AI review guide right away (-g is --guide; see below)
```

If both arguments exist on disk, they are compared as paths. Use `ss -- a b` to pass them to `git diff` as pathspecs instead.

### As git's difftool

```sh
git config --global diff.tool suisai
git config --global difftool.suisai.cmd 'ss "$LOCAL" "$REMOTE"'
git config --global difftool.prompt false
```

Then:

```sh
git difftool -d             # -d (--dir-diff) shows all files in one window
git difftool -d HEAD~1
git difftool -d main...HEAD
```

Without `-d`, git opens one window per file, one after another.

The command waits until the window is closed (git needs this, because it deletes its temporary files when the tool exits). Press <kbd>q</kbd> to close.

## Opening files in your editor

Click the file path above the diff (or press <kbd>o</kbd>) to open the file in VS Code, at the first changed line. Click a line number of the new file to open it at that line. This works when the file exists on disk: in the working tree for `ss`, or the right-hand path for `ss left right`. Files that only exist in git's temporary difftool copies cannot be opened.

To use another editor, set a URL with `{path}` and `{line}` placeholders:

```sh
git config --global suisai.editorUrl 'cursor://file{path}:{line}'   # Cursor
git config --global suisai.editorUrl 'zed://file{path}:{line}'      # Zed
```

## AI review guides

Suisai can ask an AI agent to write a review guide for the diff: the changes grouped by purpose, in an order that explains the change step by step, with an explanation for each group.

1. Install [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) (sign in to Codex with your ChatGPT account using `codex login`).
2. Open the **Guide** tab in the sidebar (or press <kbd>a</kbd>), click **Connect an AI agent** and pick one.
3. Click **Generate guide**, or start Suisai with `-g` / `--guide` (e.g. `ss -g`, `ss -g main...HEAD`) to open the guide and start writing it right away.

The agent runs on your computer, in the repository, with read-only tools. Guides are saved in `~/Library/Caches/com.marcoskwkm.suisai`, one per repository and set of `git diff` arguments. When the diff changes (press <kbd>r</kbd>, or open `ss` again), the guide updates itself: changes that are still there keep their place, removed ones disappear right away, and the agent only gets the new or rewritten changes to place, plus a list of what each step lost so it can update those explanations. If most of the diff is new, the guide is written again from scratch.

Explanations can include diagrams and charts (flowcharts, sequence and state diagrams, pie and bar charts), which the agent writes in [Mermaid](https://mermaid.js.org) and Suisai draws in the app. The agent settings let you pick the model and edit the prompt's instructions for grouping and writing.

In the guide, <kbd>Tab</kbd> / <kbd>[</kbd> <kbd>]</kbd> move between steps, and <kbd>n</kbd> / <kbd>p</kbd> move between changes, continuing into the next step.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| <kbd>Tab</kbd> / <kbd>]</kbd> | Next file |
| <kbd>⇧ Tab</kbd> / <kbd>[</kbd> | Previous file |
| <kbd>n</kbd> / <kbd>p</kbd> | Next / previous change (continues into the next file) |
| <kbd>j</kbd> <kbd>k</kbd> <kbd>↓</kbd> <kbd>↑</kbd> | Scroll |
| <kbd>Space</kbd> / <kbd>⇧ Space</kbd> | Page down / up |
| <kbd>g</kbd> / <kbd>G</kbd> | Top / bottom |
| <kbd>s</kbd> | Toggle split / unified |
| <kbd>w</kbd> | Toggle hide whitespace |
| <kbd>z</kbd> | Toggle line wrapping |
| <kbd>b</kbd> | Toggle sidebar |
| <kbd>t</kbd> | Cycle theme (system / light / dark) |
| <kbd>/</kbd> | Filter files |
| <kbd>a</kbd> | Switch between files and the review guide |
| <kbd>o</kbd> | Open file in editor |
| <kbd>r</kbd> | Reload |
| <kbd>q</kbd> | Close window |

## Building

Requirements: [Node.js](https://nodejs.org) with [pnpm](https://pnpm.io), [Rust](https://rustup.rs), and Xcode Command Line Tools.

```sh
pnpm install
pnpm tauri build --bundles app     # builds src-tauri/target/release/bundle/macos/Suisai.app
scripts/install-cli.sh             # installs an `ss` command in ~/.local/bin
```

Optionally copy `Suisai.app` to `/Applications` and pass its path to `scripts/install-cli.sh`.

The command is called `ss` by default. To use another name (for example if you already have Linux's `ss` installed), run `CLI_NAME=suisai scripts/install-cli.sh`.

## Development

```sh
ss-dev                  # like `ss`, but runs this checkout from source with live reloading
pnpm test               # frontend unit tests (vitest)
pnpm check              # type-check
cd src-tauri && cargo test
```

`ss-dev` (installed by `scripts/install-cli.sh`, or run `scripts/dev.sh` directly) takes the same arguments as `ss` and works from any directory, e.g. `ss-dev --staged` or `ss-dev HEAD~1`. Changes to the code show up in the open window: the UI updates in place, and the app is rebuilt and restarted when Rust code changes. Only one dev window can run at a time. It stores its settings separately from the built app, so connect the AI agent again the first time.

`ss` keeps running the built app until you rebuild it with `pnpm tauri build --bundles app`.

### Working on the UI in a browser

The UI can run in a normal browser with recorded data, which is handy for design work:

```sh
node scripts/record-mock.ts ~/code/some-repo HEAD~1   # writes dev/mock.json
pnpm dev                                             # open http://localhost:1420
```

## How it works

- **Backend (Rust, `src-tauri/`)**: parses the command line, runs `git diff` with flags that make the output predictable regardless of your git config, and reads the full old/new file contents (`git cat-file` for committed blobs, the file on disk for the working tree).
  - Path mode runs `git diff --no-index`. `git difftool -d` fills its temp dir with symlinks to your working tree, which `git diff --no-index` would compare as links, so trees with symlinks are first copied with the links resolved.
  - Hiding whitespace runs git a second time with `-w`. Files missing from that output are kept in the list and marked as whitespace-only.
- **Frontend (Svelte 5 + TypeScript, `src/`)**: parses the unified diff (`src/lib/git/parse.ts`), builds the rows for split/unified views (`src/lib/diff/rows.ts`), and renders only the visible rows (`DiffView.svelte`).
  - Syntax highlighting runs on the full files in a Web Worker, so multi-line strings and comments come out right. Files over 500 KB are shown without highlighting.
