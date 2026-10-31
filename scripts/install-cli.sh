#!/bin/sh
# Installs a command (`ss` by default) that launches Suisai, so it can be used
# from the terminal and as git's difftool.
#
#   scripts/install-cli.sh [path/to/Suisai.app]
#
# Defaults to the app built by `pnpm tauri build`. Environment variables:
#   CLI_NAME  name of the command (default: ss)
#   BIN_DIR   where to put it (default: ~/.local/bin)
set -eu

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
app=${1:-"$repo_dir/src-tauri/target/release/bundle/macos/Suisai.app"}
name=${CLI_NAME:-ss}
bin_dir=${BIN_DIR:-"$HOME/.local/bin"}
exe="$app/Contents/MacOS/suisai"

if [ ! -x "$exe" ]; then
  echo "error: $exe not found. Build the app first with: pnpm tauri build --bundles app" >&2
  exit 1
fi
app=$(cd "$app" && pwd)

# Don't shadow an existing command (e.g. Linux's `ss`) without asking.
existing=$(command -v "$name" 2>/dev/null || true)
if [ -n "$existing" ] && [ "$existing" != "$bin_dir/$name" ]; then
  echo "error: '$name' already exists at $existing. Choose another name with CLI_NAME=..." >&2
  exit 1
fi

mkdir -p "$bin_dir"
cat > "$bin_dir/$name" <<SCRIPT
#!/bin/sh
exec "$app/Contents/MacOS/suisai" "\$@"
SCRIPT
chmod +x "$bin_dir/$name"

echo "Installed $bin_dir/$name -> $app"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: $bin_dir is not on your PATH" ;;
esac

cat <<NEXT

To use it as git's difftool:

  git config --global diff.tool suisai
  git config --global difftool.suisai.cmd '$name "\$LOCAL" "\$REMOTE"'
  git config --global difftool.prompt false

Then run \`git difftool -d\` (optionally with commits, e.g. \`git difftool -d main...HEAD\`).
NEXT
