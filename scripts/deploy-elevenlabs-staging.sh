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

if [[ -z "$CLOUDFLARE_API_TOKEN" ]]; then
  printf "No token was entered. Nothing was changed.\n" >&2
  exit 1
fi
ELEVENLABS_LLM_BEARER_TOKEN="$(openssl rand -hex 32)"
export ELEVENLABS_LLM_BEARER_TOKEN

printf "Setting the private ElevenLabs Bearer secret in Cloudflare staging...\n"
printf '%s' "$ELEVENLABS_LLM_BEARER_TOKEN" |
  WRANGLER_LOG_PATH=/tmp/pierce-wrangler-secret.log \
  npx wrangler secret put ELEVENLABS_LLM_BEARER_TOKEN --env staging

printf "Deploying the staging Worker...\n"
WRANGLER_LOG_PATH=/tmp/pierce-wrangler-deploy.log \
  npx wrangler deploy --env staging

printf "Authorization: Bearer %s\n" "$ELEVENLABS_LLM_BEARER_TOKEN" > "$HEADER_FILE"

printf "Testing that unauthenticated requests are rejected...\n"
UNAUTH_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$ENDPOINT" \
  -H 'content-type: application/json' \
  --data '{"stream":true,"messages":[{"role":"user","content":"health check"}]}')"
if [[ "$UNAUTH_STATUS" != "401" ]]; then
  printf "Expected HTTP 401, received %s.\n" "$UNAUTH_STATUS" >&2
  exit 1
fi
printf "Testing authenticated Granite streaming...\n"
AUTH_STATUS="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "$ENDPOINT" \
  -H 'content-type: application/json' \
  -H "@$HEADER_FILE" \
  --data '{"model":"ignored","stream":true,"max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: Pierce staging is ready."}]}')"
if [[ "$AUTH_STATUS" != "200" ]] || ! grep -q 'data: \[DONE\]' "$RESPONSE_FILE"; then
  printf "Authenticated streaming test failed with HTTP %s.\n" "$AUTH_STATUS" >&2
  exit 1
fi

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$ELEVENLABS_LLM_BEARER_TOKEN" | pbcopy
  printf "Deployment and tests passed. The ElevenLabs Bearer secret is now on your clipboard.\n"
  printf "Paste it into ElevenLabs when prompted; do not paste it into chat.\n"
else
  printf "Deployment passed, but clipboard access was unavailable.\n" >&2
  exit 1
fi
