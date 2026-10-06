#!/usr/bin/env bash
# Cline Memory - Phase 0 verifier.
set -euo pipefail

STORE="${CLINE_MEM_STORE:-$HOME/.llm-memory}"
DATA="${CLINE_DATA_DIR:-$HOME/.cline/data}"
RAW="$STORE/raw/hooks"
SESSIONS="$DATA/sessions"

echo "== 1. Hook events =="
if compgen -G "$RAW/*.jsonl" >/dev/null 2>&1; then
  cat "$RAW"/*.jsonl | jq -r '.event' | sort | uniq -c | sort -rn
else
  echo "NO hook events found in $RAW"
fi

echo
echo "== 2. Task ids seen by hooks =="
cat "$RAW"/*.jsonl 2>/dev/null | jq -r '.payload.taskId // empty' | sort -u | head -10

echo
echo "== 3. Prompt capture sample =="
cat "$RAW"/*.jsonl 2>/dev/null | jq -r 'select(.event=="UserPromptSubmit") | .payload.userPromptSubmit.prompt // empty' | head -3

echo
echo
echo "== 4. Injection proof =="
NONCE="$(jq -r '.nonce // empty' "$STORE/phase0-inject.json" 2>/dev/null || true)"
echo "nonce: ${NONCE:-<none>}"
if [[ -n "$NONCE" && -d "$SESSIONS" ]]; then
  if grep -rl "$NONCE" "$SESSIONS" >/dev/null 2>&1; then
    echo "FOUND nonce in session messages:"
    grep -rl "$NONCE" "$SESSIONS" | head -5
  else
    echo "NOT FOUND in session messages yet."
  fi
fi

echo
echo "== 5. Session storage =="
if [[ -d "$SESSIONS" ]]; then
  echo "session dirs: $(ls -1 "$SESSIONS" | wc -l | tr -d ' ')"
  latest="$(ls -1t "$SESSIONS" | head -1)"
  if [[ -n "$latest" ]]; then
    echo "latest session: $latest"
    ls -la "$SESSIONS/$latest" | head -10
    if [[ -f "$SESSIONS/$latest/$latest.json" ]]; then
      jq -r '"source=\(.source) provider=\(.provider) model=\(.model) status=\(.status) workspace=\(.workspace_root)"' \
        "$SESSIONS/$latest/$latest.json" 2>/dev/null || true
    fi
  fi
else
  echo "NO session dir at $SESSIONS"
fi

echo
echo "== 6. hooksEnabled =="
GS="$DATA/globalState.json"
if [[ -f "$GS" ]] && command -v jq >/dev/null 2>&1; then
  jq -r '"hooksEnabled=\(.hooksEnabled // "absent")"' "$GS" 2>/dev/null || true
fi
