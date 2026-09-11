#!/bin/sh
# beamline installer: curl -fsSL https://raw.githubusercontent.com/gothammm/beamline/main/install.sh | bash
# Usage: install.sh [tag]   (default: latest release)
# Test hook: BEAMLINE_RELEASE_BASE overrides the download root.
set -eu

TAG="${1:-latest}"
BASE="${BEAMLINE_RELEASE_BASE:-https://github.com/gothammm/beamline/releases}"
BINDIR="${BINDIR:-$HOME/.local/bin}"

step() { printf '[→] %s\n' "$1"; }
ok() { printf '[✓] %s\n' "$1"; }
die() { printf '[✗] %s (fix: %s)\n' "$1" "$2" >&2; exit 1; }

command -v curl >/dev/null || die "curl not found" "install curl, then re-run this script"
command -v uname >/dev/null || die "uname not found" "run on Linux, macOS, or Git Bash"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64) ASSET="beamline-linux-x64" ;;
  Darwin-arm64) ASSET="beamline-darwin-arm64" ;;
  Darwin-x86_64) die "no Intel macOS binary for $OS-$ARCH" "bun install -g github:gothammm/beamline" ;;
  MINGW*|MSYS*|CYGWIN*) ASSET="beamline-windows-x64.exe" ;;
  *) die "unsupported platform $OS-$ARCH" "bun install -g github:gothammm/beamline" ;;
esac
ok "platform — $OS-$ARCH → $ASSET"

if [ "$TAG" = "latest" ]; then
  URL="$BASE/latest/download/$ASSET"
else
  URL="$BASE/download/$TAG/$ASSET"
fi

mkdir -p "$BINDIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM
step "downloading $URL"
curl -fSL --progress-bar -o "$TMP" "$URL" || die "download failed" "check your network and re-run"
SIZE=$(wc -c <"$TMP" | tr -d ' ')
ok "downloaded — $SIZE bytes"
mv "$TMP" "$BINDIR/beamline"
chmod +x "$BINDIR/beamline"
ok "installed — $BINDIR/beamline"

# Unsigned binary: clear macOS Gatekeeper on first install.
if [ "$OS" = "Darwin" ]; then
  if xattr -d com.apple.quarantine "$BINDIR/beamline" 2>/dev/null; then
    ok "gatekeeper — quarantine cleared"
  fi
fi

VER="$("$BINDIR/beamline" --version 2>/dev/null)" || die "installed binary won't run" "re-run this script"
ok "verified — beamline $VER"

case ":$PATH:" in
  *":$BINDIR:"*) ok "on PATH — $BINDIR" ;;
  *) printf '[✗] %s (fix: %s)\n' "$BINDIR not on PATH" "export PATH=\"\$PATH:$BINDIR\"" >&2 ;;
esac
