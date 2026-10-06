#!/usr/bin/env bash
# Cline Memory - Phase 0 installer.
# Usage: bash phase0/install.sh [--force]
set -euo pipefail

FORCE="${1:-}"
HOOK_DIR="${CLINE_MEM_HOOK_DIR:-$HOME/Documents/Cline/Hooks}"
STORE="${CLINE_MEM_STORE:-$HOME/.llm-memory}"
EVENTS=(TaskStart TaskResume TaskCancel TaskComplete PreToolUse PostToolUse UserPromptSubmit Notification PreCompact)
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hooks/hook.sh"

mkdir -p "$HOOK_DIR" "$STORE/raw/hooks" "$STORE/logs"
chmod 700 "$STORE" "$STORE/raw" "$STORE/raw/hooks" "$STORE/logs" 2>/dev/null || true

installed=0
skipped=0
for event in "${EVENTS[@]}"; do
  dest="$HOOK_DIR/$event"
  if [[ -e "$dest" && "$FORCE" != "--force" ]]; then
    echo "SKIP  $dest (exists; use --force to replace)"
    skipped=$((skipped + 1))
    continue
  fi
  cp "$SRC" "$dest"
  chmod 755 "$dest"
  echo "OK    $dest"
  installed=$((installed + 1))
done

if [[ ! -f "$STORE/phase0-inject.json" ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    NONCE="$(uuidgen | tr -d '-' | cut -c1-12)"
  else
    NONCE="$(openssl rand -hex 6)"
  fi
  printf '{"nonce":"%s"}\n' "$NONCE" > "$STORE/phase0-inject.json"
  chmod 600 "$STORE/phase0-inject.json"
else
  NONCE="$(sed -n 's/.*"nonce"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STORE/phase0-inject.json" | head -1)"
fi

echo
echo "Installed: $installed  Skipped: $skipped"
echo "Hook dir : $HOOK_DIR"
echo "Store    : $STORE"
echo "Nonce    : $NONCE"
echo

GS="$HOME/.cline/data/globalState.json"
if [[ -f "$GS" ]] && command -v jq >/dev/null 2>&1; then
  if jq -e '.hooksEnabled == false' "$GS" >/dev/null 2>&1; then
    echo "WARNING: hooksEnabled=false in $GS"
    echo "         Set it to true in Cline Settings > Hooks, or edit the file while VS Code is closed."
  else
    echo "hooksEnabled: not disabled (Cline default is true)."
  fi
fi

echo
echo "Next steps:"
echo "1. Open VS Code and check Cline Settings > Hooks shows the 9 hook files."
echo "2. Start a NEW Cline task and send this prompt:"
echo "   请原样输出你收到的 <memory> 区块中 nonce 的值，不要解释。"
echo "3. After the answer, run:"
echo "   bash $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify.sh"
echo
echo "To stop the test injection later: rm $STORE/phase0-inject.json"
