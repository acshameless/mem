#!/usr/bin/env bash
# Cline Memory - Phase 0 uninstaller.
# Removes only hook files created by phase0/install.sh. Keeps raw data.
set -euo pipefail

HOOK_DIR="${CLINE_MEM_HOOK_DIR:-$HOME/Documents/Cline/Hooks}"
STORE="${CLINE_MEM_STORE:-$HOME/.llm-memory}"
EVENTS=(TaskStart TaskResume TaskCancel TaskComplete PreToolUse PostToolUse UserPromptSubmit Notification PreCompact)

for event in "${EVENTS[@]}"; do
  dest="$HOOK_DIR/$event"
  if [[ -f "$dest" ]] && grep -q "Cline Memory - Phase 0 hook" "$dest" 2>/dev/null; then
    rm -- "$dest"
    echo "REMOVED $dest"
  else
    echo "SKIP    $dest (not a Phase 0 hook)"
  fi
done

echo
echo "Raw data kept at: $STORE"
echo "Injection marker: $STORE/phase0-inject.json"
echo "Delete the marker to stop injection. Delete the store to remove all captured data."
