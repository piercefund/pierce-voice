#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/kurlingrobinson/Documents/Codex/2026-06-28/pierce-voice"
BASE_URL="https://pierce-voice-cloudflare-staging.piercefund.workers.dev"
RESPONSE_FILE="$(mktemp -t pierce-elevenlabs-tools.XXXXXX)"

cleanup() {
  rm -f "$RESPONSE_FILE"
  unset CLOUDFLARE_API_TOKEN ELEVENLABS_TOOL_BEARER_TOKEN
}
trap cleanup EXIT INT TERM
chmod 600 "$RESPONSE_FILE"

cd "$PROJECT_DIR"

printf "Paste the temporary Cloudflare deployment token, then press Return (input is hidden): "
IFS= read -r -s CLOUDFLARE_API_TOKEN
printf "\n"
export CLOUDFLARE_API_TOKEN

if [[ -z "$CLOUDFLARE_API_TOKEN" ]]; then
  printf "No token was entered. Nothing was changed.\n" >&2
  exit 1
fi

if [[ "$CLOUDFLARE_API_TOKEN" == Bearer\ * ]] || [[ "$CLOUDFLARE_API_TOKEN" =~ [[:space:]] ]]; then
  printf "That is not the raw Cloudflare deployment token. Paste the token value only—once—with no 'Bearer ' prefix, quotes, or spaces.\n" >&2
  exit 1
fi

npm run test:elevenlabs-tools

ELEVENLABS_TOOL_BEARER_TOKEN="$(openssl rand -hex 32)"
export ELEVENLABS_TOOL_BEARER_TOKEN

printf "Setting the dedicated ElevenLabs tool secret in Cloudflare staging...\n"
printf '%s' "$ELEVENLABS_TOOL_BEARER_TOKEN" |
  WRANGLER_LOG_PATH=/tmp/pierce-wrangler-tool-secret.log \
  npx wrangler secret put ELEVENLABS_TOOL_BEARER_TOKEN --env staging

printf "Deploying the two lookup routes to Cloudflare staging...\n"
set +e
WRANGLER_LOG_PATH=/tmp/pierce-wrangler-tools-deploy.log \
  npx wrangler deploy --env staging
DEPLOY_STATUS=$?
set -e

printf "Verifying that unauthenticated tool requests are rejected...\n"
UNAUTH_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$BASE_URL/tools/lookup-resource-directory" \
  -H 'content-type: application/json' \
  --data '{"query":"career training"}')"
if [[ "$UNAUTH_STATUS" != "401" ]]; then
  printf "The new tool route is not active yet (HTTP %s). Wrangler exit status: %s.\n" "$UNAUTH_STATUS" "$DEPLOY_STATUS" >&2
  exit 1
fi

printf "Testing the authenticated Pierce resource directory...\n"
RESOURCE_STATUS="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "$BASE_URL/tools/lookup-resource-directory" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $ELEVENLABS_TOOL_BEARER_TOKEN" \
  --data '{"query":"technology job training","location":"San Diego","limit":3}')"
if [[ "$RESOURCE_STATUS" != "200" ]] || ! grep -q 'climb_hire_san_diego' "$RESPONSE_FILE"; then
  printf "The authenticated resource-directory test failed (HTTP %s).\n" "$RESOURCE_STATUS" >&2
  exit 1
fi

printf "Testing the authenticated O*NET lookup...\n"
ONET_STATUS="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "$BASE_URL/tools/lookup-onet-career" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $ELEVENLABS_TOOL_BEARER_TOKEN" \
  --data '{"query":"project management","limit":2}')"
if [[ "$ONET_STATUS" != "200" ]] || ! grep -q 'O.NET Web Services' "$RESPONSE_FILE"; then
  printf "The authenticated O*NET test failed (HTTP %s).\n" "$ONET_STATUS" >&2
  exit 1
fi

if command -v pbcopy >/dev/null 2>&1; then
  printf 'Bearer %s' "$ELEVENLABS_TOOL_BEARER_TOKEN" | pbcopy
  printf "Both staging lookup tools passed.\n"
  printf "The complete Authorization header value is on your clipboard. Add it to ElevenLabs as a secret; do not paste it into chat.\n"
else
  printf "Tests passed, but clipboard access was unavailable.\n" >&2
  exit 1
fi
