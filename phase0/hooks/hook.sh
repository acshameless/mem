#!/bin/bash
# Cline Memory - Phase 0 hook.
# Install one copy per event. The file name is the event name.
# Input: JSON on stdin. Output: JSON on stdout.
set -u

EVENT="$(basename "$0")"
STORE="${CLINE_MEM_STORE:-$HOME/.llm-memory}"
RAW_DIR="$STORE/raw/hooks"

mkdir -p "$RAW_DIR" 2>/dev/null
chmod 700 "$STORE" "$RAW_DIR" 2>/dev/null

INPUT="$(cat)"
if [[ -z "$INPUT" ]]; then
  INPUT="{}"
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DAY="$(date -u +%Y-%m-%d)"

printf '{"event":"%s","received_at":"%s","payload":%s}\n' \
  "$EVENT" "$TS" "$INPUT" >> "$RAW_DIR/$DAY.jsonl" 2>/dev/null

CTX=""
if [[ "$EVENT" == "UserPromptSubmit" && -f "$STORE/phase0-inject.json" ]]; then
  NONCE="$(sed -n 's/.*"nonce"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STORE/phase0-inject.json" | head -1)"
  if [[ -n "${NONCE:-}" ]]; then
    CTX='<memory version="1" phase="0"><hint>CLINE_MEM_PHASE0_OK nonce='"$NONCE"'</hint></memory>'
  fi
fi

if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$CTX" '{cancel:false, contextModification:$ctx, errorMessage:""}'
else
  if [[ -z "$CTX" ]]; then
    echo '{"cancel":false,"contextModification":"","errorMessage":""}'
  else
    ESC="$(printf '%s' "$CTX" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    printf '{"cancel":false,"contextModification":"%s","errorMessage":""}\n' "$ESC"
  fi
fi

exit 0
