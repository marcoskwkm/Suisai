#!/bin/sh
# Runs Suisai from source, in dev mode, as if `ss` had been started in the
# current directory: `scripts/dev.sh --staged` is the dev version of
# `ss --staged`. Changes to the code show up in the open window: the UI
# reloads in place, and the app is rebuilt and restarted when Rust code changes.
#
#   scripts/dev.sh [ss arguments]
#
# scripts/install-cli.sh installs this as `ss-dev`.
set -eu

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cwd=$(pwd)

# Rust is often only on the PATH of interactive shells.
if ! command -v cargo >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/cargo" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
fi

# The UI dev server has a fixed port, so only one dev window can run at a time.
if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: port 1420 is in use (another Suisai dev window or 'pnpm dev' is running)" >&2
  exit 1
fi

cd "$repo_dir"
# After the first `--`: arguments for cargo (none). After the second: for the app.
# `-C` makes the app run as if started where this script was run.
exec "$repo_dir/node_modules/.bin/tauri" dev -- -- -C "$cwd" "$@"
