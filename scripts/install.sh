#!/bin/sh
# TokenPilot installer: macOS Apple Silicon. No sudo or security-policy changes.
set -eu
VERSION=1.2.1
ARCHIVE_SHA256=9151f85c164be8987057a4b7f2f568882c7949bea23da8d957bf46aad7babac2
RELEASE=https://github.com/gregorygerman777-hub/TOKENPILOT/releases/download/v1.2.1
root=$HOME
archive=
launch=1
profile=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive) [ "$#" -ge 2 ] || exit 2; archive=$2; shift 2 ;;
    --prefix) [ "$#" -ge 2 ] || exit 2; root=$2; profile=0; shift 2 ;;
    --no-open) launch=0; shift ;;
    --no-path) profile=0; shift ;;
    --help) echo 'Usage: sh install.sh [--archive app.zip] [--prefix directory] [--no-open] [--no-path]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
fail() { echo "TokenPilot: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'This release supports macOS only.'
[ "$(uname -m)" = arm64 ] || fail 'This release needs Apple Silicon. Intel builds are not available.'
case "$root" in /*) ;; *) fail 'Install prefix must be an absolute path.' ;; esac
for cmd in curl shasum ditto mktemp; do command -v "$cmd" >/dev/null || fail "Missing required command: $cmd"; done
mkdir -p "$root"
root=$(CDPATH= cd "$root" && pwd -P)
app="$root/Applications/TokenPilot.app"
bin="$root/.local/bin/tokenpilot"
[ ! -L "$app" ] && [ ! -L "$bin" ] || fail 'Refusing to replace a symlink at the install destination.'
if [ -e "$app" ]; then
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)" = local.tokenpilot.desktop ] || fail 'An unrelated app exists at the destination.'
fi
if [ -e "$bin" ]; then
  grep -q '^# TokenPilot managed launcher$' "$bin" || fail 'An unrelated tokenpilot command exists at the destination.'
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/tokenpilot-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
if [ -z "$archive" ]; then
  archive="$tmp/app.zip"
  echo "Downloading TokenPilot $VERSION..."
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "$RELEASE/TokenPilot-$VERSION-arm64-mac.zip" -o "$archive"
fi
[ -f "$archive" ] || fail 'Archive not found.'
actual=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
[ "$actual" = "$ARCHIVE_SHA256" ] || fail 'Checksum mismatch. Nothing was installed; download the release again.'
ditto -x -k "$archive" "$tmp/unpacked"
staged="$tmp/unpacked/TokenPilot.app"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$staged/Contents/Info.plist")" = local.tokenpilot.desktop ] || fail 'Unexpected app identifier.'
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$staged/Contents/Info.plist")" = "$VERSION" ] || fail 'Unexpected app version.'
mkdir -p "$root/Applications" "$root/.local/bin"
backup=
if [ -e "$app" ]; then
  backup="$root/Applications/TokenPilot.previous.$(date +%s).app"
  [ ! -e "$backup" ] || fail 'Backup already exists. Try again later.'
  mv "$app" "$backup"
fi
if ! ditto "$staged" "$app"; then
  rm -rf "$app"
  [ -z "$backup" ] || mv "$backup" "$app"
  fail 'Copy failed; previous app restored.'
fi
cat > "$tmp/launcher" <<'LAUNCHER'
#!/bin/sh
# TokenPilot managed launcher
set -eu
root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd -P)
app="$root/Applications/TokenPilot.app"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ "${1:-}" = open ]; then exec open "$app"; fi
export ELECTRON_RUN_AS_NODE=1
exec "$app/Contents/MacOS/TokenPilot" "$app/Contents/Resources/app.asar/src/cli.cjs" "$@"
LAUNCHER
chmod 755 "$tmp/launcher"
mv "$tmp/launcher" "$bin"
if [ "$profile" -eq 1 ]; then
  case "${SHELL:-/bin/zsh}" in */bash) config="$HOME/.bash_profile" ;; */zsh) config="$HOME/.zprofile" ;; *) config= ;; esac
  if [ -n "$config" ]; then
    if ! grep -q '^# TokenPilot CLI path$' "$config" 2>/dev/null; then
      printf '\n# TokenPilot CLI path\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$config"
    fi
  fi
fi
printf '\nInstalled TokenPilot %s\nApp: %s\nCLI: %s\n' "$VERSION" "$app" "$bin"
[ -z "$backup" ] || printf 'Previous app retained: %s\n' "$backup"
echo 'Open a new Terminal, then run: tokenpilot status'
echo 'For scans: brew install semgrep gitleaks'
echo 'The app is unsigned. If macOS blocks it, review it in System Settings > Privacy & Security. This installer does not bypass Gatekeeper.'
if [ "$launch" -eq 1 ]; then
  open "$app" || echo "Open $app from Finder after reviewing the macOS security prompt."
fi
