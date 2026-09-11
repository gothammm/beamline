#!/bin/sh
# beamline installer: curl -fsSL https://raw.githubusercontent.com/gothammm/beamline/main/install.sh | bash
# Usage: install.sh [tag]   (default: latest release)
# Test hook: BEAMLINE_RELEASE_BASE overrides the download root.
set -eu

TAG="${1:-latest}"
BASE="${BEAMLINE_RELEASE_BASE:-https://github.com/gothammm/beamline/releases}"
BINDIR="${BINDIR:-$HOME/.local/bin}"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64) ASSET="beamline-linux-x64" ;;
  Darwin-arm64) ASSET="beamline-darwin-arm64" ;;
  Darwin-x86_64) echo "beamline: no Intel macOS binary — use: bun install -g github:gothammm/beamline" >&2; exit 1 ;;
  MINGW*|MSYS*|CYGWIN*) ASSET="beamline-windows-x64.exe" ;;
  *) echo "beamline: unsupported platform $OS-$ARCH" >&2; exit 1 ;;
esac

if [ "$TAG" = "latest" ]; then
  URL="$BASE/latest/download/$ASSET"
else
  URL="$BASE/download/$TAG/$ASSET"
fi

mkdir -p "$BINDIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM
curl -fsSL -o "$TMP" "$URL"
mv "$TMP" "$BINDIR/beamline"
chmod +x "$BINDIR/beamline"
# Unsigned binary: clear macOS Gatekeeper on first install.
if [ "$OS" = "Darwin" ]; then xattr -d com.apple.quarantine "$BINDIR/beamline" 2>/dev/null || true; fi

"$BINDIR/beamline" --version
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "beamline: add $BINDIR to your PATH" >&2 ;;
esac
