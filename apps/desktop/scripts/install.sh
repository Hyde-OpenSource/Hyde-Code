#!/usr/bin/env bash
# Builds Hyde AI and installs it for the current user (no sudo):
#   ~/.local/bin/hyde-ai, a desktop launcher, and an app icon.
# (`hyde` on its own belongs to Hyde Code; this never touches it.)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

if ! command -v cargo >/dev/null 2>&1; then
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  else
    echo "Rust is not installed. Install it from https://rustup.rs and run this again." >&2
    exit 1
  fi
fi

echo "→ Building Hyde AI (release)…"
cargo build --release --manifest-path "$ROOT/Cargo.toml" -p hyde-ai

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
install -m 755 "$ROOT/target/release/hyde-ai" "$BIN_DIR/hyde-ai"
install -m 644 "$ROOT/crates/hyde-ai/ui/icon.svg" "$ICON_DIR/hyde-ai.svg"
sed "s|@BIN@|$BIN_DIR/hyde-ai|" "$ROOT/packaging/hyde-ai.desktop" > "$APP_DIR/hyde-ai.desktop"
chmod 644 "$APP_DIR/hyde-ai.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true

echo "✓ Installed $BIN_DIR/hyde-ai"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  Add $BIN_DIR to your PATH to run \`hyde-ai\` from a terminal." ;;
esac
echo "  Start it from your app menu (Hyde AI) or run: hyde-ai"
