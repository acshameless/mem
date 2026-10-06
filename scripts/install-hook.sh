#!/usr/bin/env bash
# Replace the Phase 0 UserPromptSubmit hook with the real recall hook.
set -euo pipefail

HOOK_DIR="${CLINE_HOOK_DIR:-$HOME/Documents/Cline/Hooks}"
SERVER_DIR="${MEM_SERVER_DIR:-$HOME/Github/mem}"
NODE_BIN="${MEM_NODE_BIN:-$(command -v node)}"
TARGET="$HOOK_DIR/UserPromptSubmit"

mkdir -p "$HOOK_DIR"
if [[ -f "$TARGET" ]]; then
  cp "$TARGET" "$TARGET.bak.$(date +%Y%m%d%H%M%S)"
fi

cat > "$TARGET" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$SERVER_DIR/src/hooks/user_prompt_submit.ts"
EOF

chmod 755 "$TARGET"
echo "installed $TARGET"
echo "node:   $NODE_BIN"
echo "hook:   $SERVER_DIR/src/hooks/user_prompt_submit.ts"
echo
echo "The old hook, if any, is saved next to it as UserPromptSubmit.bak.<timestamp>."
echo "The daemon must be running so the database stays current."
