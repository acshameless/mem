#!/usr/bin/env bash
# Write the distillation model config to ~/.llm-memory/config.json (0600).
set -euo pipefail

STORE="${MEM_HOME:-$HOME/.llm-memory}"
CONFIG="$STORE/config.json"
MODEL="${MEM_DISTILL_MODEL:-deepseek-chat}"
BASE_URL="${MEM_DISTILL_BASE_URL:-https://api.deepseek.com}"

mkdir -p "$STORE"
chmod 700 "$STORE" 2>/dev/null || true

printf 'Model [%s]: ' "$MODEL"
read -r model_input || true
MODEL="${model_input:-$MODEL}"

printf 'Base URL [%s]: ' "$BASE_URL"
read -r base_input || true
BASE_URL="${base_input:-$BASE_URL}"

printf 'API key (hidden): '
read -r -s API_KEY
echo
if [[ -z "$API_KEY" ]]; then
  echo "no key provided"
  exit 1
fi

tmp="$(mktemp "${CONFIG}.tmp.XXXXXX")"
existing="{}"
if [[ -f "$CONFIG" ]]; then
  existing="$(cat "$CONFIG")"
fi
jq -n --argjson old "$existing" \
  --arg provider "deepseek" \
  --arg baseUrl "$BASE_URL" \
  --arg model "$MODEL" \
  --arg apiKey "$API_KEY" \
  '$old + {distill:{provider:$provider, baseUrl:$baseUrl, model:$model, apiKey:$apiKey, maxSessionsPerRun:20, maxCharsPerSession:8000, temperature:0.2}}
   | .autoDistill //= {enabled:false, quietMinutes:15, scanMinutes:5, maxSessionsPerCycle:3, reDistillOnChange:true}' \
  > "$tmp"
mv "$tmp" "$CONFIG"
chmod 600 "$CONFIG"

echo "wrote $CONFIG (0600)"
