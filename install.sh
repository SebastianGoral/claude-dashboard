#!/bin/bash
# Installs the newest claude-dash desktop app into /Applications.
# Usage: curl -fsSL https://raw.githubusercontent.com/SebastianGoral/claude-dashboard/main/install.sh | bash
set -euo pipefail

REPO="SebastianGoral/claude-dashboard"
APP="/Applications/claude-dash.app"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "claude-dash runs only on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unknown Mac type: $(uname -m)" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading claude-dash ($ARCH)..."
curl -fL --progress-bar -o "$TMP/claude-dash.zip" "https://github.com/$REPO/releases/latest/download/claude-dash-$ARCH.zip"
ditto -x -k "$TMP/claude-dash.zip" "$TMP"

# Quit a running copy. Remove the old app first: files left from an old version break the signature.
osascript -e 'quit app "claude-dash"' >/dev/null 2>&1 || true
rm -rf "$APP"
mv "$TMP/claude-dash.app" "$APP"
# The app has no Apple developer signature. Without this, macOS blocks it.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Installed $APP"
open "$APP"
