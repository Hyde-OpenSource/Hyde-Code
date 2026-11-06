#!/usr/bin/env bash
# Installs all of Hyde AI for the current user (no sudo):
#   hyde     Hyde Code: the coding-agent hub, office and CLI   (symlink in ~/.local/bin)
#   hyde-ai  Hyde AI: the voice and desktop assistant           (binary in ~/.local/bin + app menu)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ $1 is required: $2" >&2; exit 1; }; }
need node "install Node.js 24+ from https://nodejs.org"
need git "install git"
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then echo "✗ Node.js 24+ is required (found $(node -v))" >&2; exit 1; fi

echo "→ Hyde Code (hub, office, CLI)"
command -v pnpm >/dev/null 2>&1 || corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
pnpm install-cli

echo "→ Hyde AI (desktop assistant)"
bash apps/desktop/scripts/install.sh

echo
echo "✓ Hyde AI is installed."
echo "  hyde        in a project folder: trust it, start the hub, open the office"
echo "  hyde ai     open the Hyde AI window (or find \"Hyde AI\" in your app menu)"
