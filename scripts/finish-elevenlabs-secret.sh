#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/kurlingrobinson/Documents/Codex/2026-06-28/pierce-voice"
ENDPOINT="https://pierce-voice-cloudflare-staging.piercefund.workers.dev/v1/chat/completions"
RESPONSE_FILE="$(mktemp -t pierce-elevenlabs-response.XXXXXX)"
HEADER_FILE="$(mktemp -t pierce-elevenlabs-header.XXXXXX)"

cleanup() {
  rm -f "$RESPONSE_FILE" "$HEADER_FILE"
  unset CLOUDFLARE_API_TOKEN ELEVENLABS_LLM_BEARER_TOKEN
}
trap cleanup EXIT INT TERM
chmod 600 "$RESPONSE_FILE" "$HEADER_FILE"
cd "$PROJECT_DIR"

printf "Paste the Cloudflare API token, then press Return (input is hidden): "
IFS= read -r -s CLOUDFLARE_API_TOKEN
printf "\n"
export CLOUDFLARE_API_TOKEN
[[ -n "$CLOUDFLARE_API_TOKEN" ]] || { printf "No token entered.\n" >&2; exit 1; }

ELEVENLABS_LLM_BEARER_TOKEN="$(openssl rand -hex 32)"
export ELEVENLABS_LLM_BEARER_TOKEN

printf "Rotating the staging Bearer secret...\n"
printf '%s' "$ELEVENLABS_LLM_BEARER_TOKEN" |
  WRANGLER_LOG_PATH=/tmp/pierce-wrangler-secret.log \
  npx wrangler secret put ELEVENLABS_LLM_BEARER_TOKEN --env staging

printf "Authorization: Bearer %s\n" "$ELEVENLABS_LLM_BEARER_TOKEN" > "$HEADER_FILE"
printf "Testing authenticated Granite streaming...\n"

AUTH_STATUS="000"
for attempt in 1 2 3 4 5; do
  AUTH_STATUS="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
    -X POST "$ENDPOINT" \
    -H 'content-type: application/json' \
    -H "@$HEADER_FILE" \
    --data '{"model":"ignored","stream":true,"max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: Pierce staging is ready."}]}')"
  if [[ "$AUTH_STATUS" == "200" ]] && grep -q 'data: \[DONE\]' "$RESPONSE_FILE"; then
    break
  fi
  sleep 2
done

if [[ "$AUTH_STATUS" != "200" ]] || ! grep -q 'data: \[DONE\]' "$RESPONSE_FILE"; then
  printf "Authenticated streaming test failed with HTTP %s.\n" "$AUTH_STATUS" >&2
  exit 1
fi

printf '%s' "$ELEVENLABS_LLM_BEARER_TOKEN" | pbcopy
printf "Authenticated streaming test passed.\n"
printf "The final ElevenLabs Bearer secret is on your clipboard. Do not paste it into chat.\n"
