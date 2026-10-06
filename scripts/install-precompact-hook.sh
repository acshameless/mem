#!/usr/bin/env bash
# Replace the Phase 0 PreCompact hook with the archive hook.
set -euo pipefail

HOOK_DIR="${CLINE_HOOK_DIR:-$HOME/Documents/Cline/Hooks}"
SERVER_DIR="${MEM_SERVER_DIR:-$HOME/Github/mem}"
NODE_BIN="${MEM_NODE_BIN:-$(command -v node)}"
TARGET="$HOOK_DIR/PreCompact"

mkdir -p "$HOOK_DIR"
if [[ -f "$TARGET" ]]; then
  cp "$TARGET" "$TARGET.bak.$(date +%Y%m%d%H%M%S)"
fi

cat > "$TARGET" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$SERVER_DIR/src/hooks/pre_compact.ts"
EOF

chmod 755 "$TARGET"
echo "installed $TARGET"
