#!/usr/bin/env bash
# One-command installer for macOS and Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== mem installer =="
command -v node >/dev/null || { echo "Node.js 24+ is required: https://nodejs.org"; exit 1; }
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$MAJOR" -ge 24 ]] || { echo "Node.js 24+ required, found $(node -v)"; exit 1; }

bash "$ROOT/scripts/configure-model.sh"

if [[ "$(uname -s)" == "Darwin" ]]; then
  bash "$ROOT/scripts/install-hook.sh"
  bash "$ROOT/scripts/install-precompact-hook.sh"
  bash "$ROOT/scripts/install-mcp.sh"
  bash "$ROOT/scripts/install-launchd.sh"
  bash "$ROOT/scripts/install-review-reminder.sh"
else
  echo "Linux detected: hooks and MCP install steps are the same;"
  echo "use scripts/install-hook.sh, install-precompact-hook.sh, install-mcp.sh."
  echo "Service management on Linux: systemd user units (coming next)."
fi

node "$ROOT/src/cli/memctl.ts" status
echo
echo "Done. Restart VS Code and check Cline Settings > Hooks / MCP Servers."
