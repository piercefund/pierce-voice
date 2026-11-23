# Cloudflare staging

This configuration creates a separate Worker named
`pierce-voice-cloudflare-staging`. It has no production route or custom domain,
and it does not change Google Cloud Run, DNS, Twilio, OpenAI webhooks, or the
Google OAuth redirect URI.

## Current staging scope

- Serves the existing `public/` application with Workers Static Assets.
- Implements `POST /session` for browser OpenAI Realtime WebRTC sessions.
- Implements an ElevenLabs-only `POST /v1/chat/completions` adapter backed by
  Workers AI and `@cf/ibm-granite/granite-4.0-h-micro`. The adapter requires a
  dedicated Bearer secret, replaces requested model IDs, prepends Pierce's
  fixed safety policy, filters tools through an allowlist, strips reasoning
  fields, and returns OpenAI-compatible SSE without logging request content.
- Exposes `GET /__cloudflare/health` with a capability summary.
- Exposes `GET /__cloudflare/persistence` with R2 binding, object-existence,
  and object-size diagnostics without returning participant data.
- Replaces the production phone-number link in HTML with a staging-only notice.
- Verifies signed OpenAI incoming-call webhooks and routes each `call_id` to a
  dedicated Durable Object. The object accepts the call, owns the outbound
  Realtime WebSocket, persists webhook and function-call idempotency, and
  invokes the migrated booking, check-in, career, Calendar, Gmail, R2, and
  HubSpot paths. The public phone link remains disabled until an isolated
  staging webhook and phone route have been tested.
- Stores staging booking and check-in JSONL records in the private
  `pierce-voice-staging-data` R2 bucket using conditional writes.
- Stores career-session summaries in R2 and supports confirmed-email lookup of
  prior-session memory. Calendar updates, research enrichment, follow-up email,
  and HubSpot synchronization remain disabled in staging.
- Stores event participant and mentor intake, participant check-in, and recap
  submissions in R2. Organizer review and consent-aware follow-up delivery are
  implemented and require an authenticated Cloudflare Access identity.
- Implements a staging-only Google OAuth connection flow for Calendar and Gmail
  scopes. The returned refresh token must be moved immediately into a Wrangler
  secret and is never persisted by the Worker.
- Uses Google Calendar to check availability, create invitations, and cancel
  events when the staging Google secrets are configured. Consented career
  follow-ups are sent through Gmail, with delivery status recorded in R2.
- Provides an organizer-managed mentor roster for San Diego Startup Week Mentoring, with
  three 30-minute starts per table from 1:00 PM through 2:00 PM Pacific Time.
  Each table supports 1–4 mentors and up to three participating founders per
  session.
  R2 conditional writes prevent duplicate table/time reservations. Participant
  and participants receive Google Calendar invitations while the Pierce event
  inbox receives every organizer notification. The
  organizer view shows confirmed, cancelled, and failed appointment records.

## Secret classification

Set these with Wrangler secrets; never place their values in this repository:

- `OPENAI_API_KEY` (required for the current staging slice)
- `OPENAI_WEBHOOK_SECRET` (required to activate the staging phone webhook)
- `GOOGLE_CLIENT_SECRET` (future calendar/Gmail migration)
- `GOOGLE_CALENDAR_REFRESH_TOKEN` (future calendar/Gmail migration)
- `HUBSPOT_SERVICE_KEY` (future HubSpot migration)
- `ELEVENLABS_LLM_BEARER_TOKEN` (required for the ElevenLabs custom LLM adapter;
  use a random value of at least 32 characters and store the same value in
  ElevenLabs)

`GOOGLE_STORAGE_ACCESS_TOKEN` is a GCP-only debug override and should not be
copied to Cloudflare. The remaining API bases, model names, event labels, and
feature flags are non-secret configuration.

## Remote setup

Complete Cloudflare OAuth first. Preview and `workers.dev` URLs are public unless
Cloudflare Access is configured, so do not enter participant data during early
staging tests.

```sh
codex mcp login cloudflare
npm install --save-dev wrangler@4.135.0
npx wrangler whoami
npx wrangler r2 bucket create pierce-voice-staging-data
npx wrangler secret put OPENAI_API_KEY --env staging
npx wrangler secret put OPENAI_WEBHOOK_SECRET --env staging
npx wrangler secret put ELEVENLABS_LLM_BEARER_TOKEN --env staging
npm run test:custom-llm
npx wrangler deploy --dry-run --env staging
npx wrangler deploy --env staging
```

After the staging deployment, configure the unpublished ElevenLabs agent's
custom LLM endpoint as:

`https://pierce-voice-cloudflare-staging.piercefund.workers.dev/v1/chat/completions`

Set its authorization to `Bearer` with the same dedicated secret. Do not add a
Cloudflare Access service token. Test web preview streaming and approved tool
calls before attaching a Twilio number, SIP trunk, or production route.

The secret command and deploy command create remote Worker versions. Run them
only against the intended Cloudflare account. Do not add a route or custom
domain until staging behavior has been verified and production cutover is
explicitly approved.

The protected organizer page manages mentor names and table assignments. The
default roster uses the 12 Startup Week mentors supplied by the organizer, and
can be reordered or expanded without collecting mentor email addresses. Set
`PIERCE_MENTOR_NOTIFICATION_EMAIL` to the event inbox; staging uses
`voice@pierce.fund`.

## Organizer Access setup

The booking and check-in application must remain public. Protect only the
organizer page and review APIs with a path-based Cloudflare Access application.

1. In Cloudflare, open **Zero Trust** > **Access** > **Applications** and create
   a self-hosted application named `Pierce staging organizer`.
2. Add these application paths for the staging hostname:
   - `pierce-voice-cloudflare-staging.piercefund.workers.dev/events/*/organizer`
   - `pierce-voice-cloudflare-staging.piercefund.workers.dev/event/review*`
   - `pierce-voice-cloudflare-staging.piercefund.workers.dev/organizer`
   - `pierce-voice-cloudflare-staging.piercefund.workers.dev/organizer.html`
   - `pierce-voice-cloudflare-staging.piercefund.workers.dev/organizer/data/*`
   - `pierce-voice-cloudflare-staging.piercefund.workers.dev/mentor-review`
3. Add an Allow policy containing only the exact organizer email address or
   approved organizer identity group. Do not use an email-domain-wide rule for
   staging participant data.
4. Deploy the Worker, open the organizer URL in a private browser window, and
   confirm that Access requires sign-in before any participant data appears.

Copy the application's **Application Audience (AUD) Tag** and the Zero Trust
team domain into the staging Worker configuration as `CF_ACCESS_AUD` and
`CF_ACCESS_TEAM_DOMAIN`. The team domain has the form
`https://TEAM_NAME.cloudflareaccess.com`. These are identifiers, not secrets.

The Worker validates the signed `Cf-Access-Jwt-Assertion` for path-based Access
and also supports `ctx.access.getIdentity()` for Worker-level Access. This
defense-in-depth check returns HTTP 403 when a valid matching Access identity is
not present.

## Next migration slices

1. Add `OPENAI_WEBHOOK_SECRET` to staging and create an isolated OpenAI Project
   webhook for `realtime.call.incoming` at
   `https://pierce-voice-cloudflare-staging.piercefund.workers.dev/webhooks/openai/realtime`.
2. Complete a non-production phone call through booking, check-in, and career
   flows. Verify R2, Calendar, Gmail, HubSpot, duplicate delivery, and graceful
   hangup before changing the production webhook or SIP trunk.
3. Document and rehearse phone rollback by disabling the staging webhook. The
   GCP production route remains unchanged until explicit cutover approval.
