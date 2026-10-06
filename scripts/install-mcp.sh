#!/usr/bin/env bash
# Register the mem MCP server with Cline.
set -euo pipefail

CFG="${CLINE_MCP_SETTINGS_PATH:-$HOME/.cline/data/settings/cline_mcp_settings.json}"
SERVER_DIR="${MEM_SERVER_DIR:-$HOME/Github/mem}"
NODE_BIN="${MEM_NODE_BIN:-$(command -v node)}"

mkdir -p "$(dirname "$CFG")"
if [[ ! -f "$CFG" ]]; then
  printf '{"mcpServers":{}}\n' > "$CFG"
fi
cp "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M%S)"

tmp="$(mktemp "${CFG}.tmp.XXXXXX")"
jq --arg node "$NODE_BIN" \
   --arg server "$SERVER_DIR/src/mcp/server.ts" \
   '.mcpServers.mem = {
      command: $node,
      args: [$server],
      disabled: false,
      autoApprove: ["mem_recall", "mem_status"],
      timeout: 60
    }' "$CFG" > "$tmp"
mv "$tmp" "$CFG"

echo "registered mem MCP server in $CFG"
echo "node:   $NODE_BIN"
echo "server: $SERVER_DIR/src/mcp/server.ts"
echo
echo "Next: reload Cline (or toggle the server in Cline MCP settings)."
