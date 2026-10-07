#!/usr/bin/env bash
# Install memctl/memd into PATH (npm link preferred, symlink fallback).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v npm >/dev/null 2>&1; then
  if (cd "$ROOT" && npm link --no-fund --no-audit >/dev/null 2>&1); then
    echo "installed via npm link: memctl, memd"
    exit 0
  fi
fi

BIN_DIR="${MEM_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
chmod +x "$ROOT/bin/memctl.mjs" "$ROOT/bin/memd.mjs"
ln -sf "$ROOT/bin/memctl.mjs" "$BIN_DIR/memctl"
ln -sf "$ROOT/bin/memd.mjs" "$BIN_DIR/memd"
echo "installed symlinks in $BIN_DIR: memctl, memd"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "add to your shell profile:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
