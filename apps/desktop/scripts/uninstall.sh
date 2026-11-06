#!/usr/bin/env bash
# Removes the files install.sh created. Your settings in ~/.config/hyde-ai are kept.
set -euo pipefail
rm -f "$HOME/.local/bin/hyde-ai" \
  "${XDG_DATA_HOME:-$HOME/.local/share}/applications/hyde-ai.desktop" \
  "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps/hyde-ai.svg"
echo "✓ Hyde AI removed (settings kept in ~/.config/hyde-ai)"
