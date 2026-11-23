# Pierce Voice Cloudflare migration report

## Current production architecture

The existing production application remains on GCP and is unchanged. It serves
the browser UI and Node API, stores JSONL application records, connects browser
and phone sessions to OpenAI Realtime, uses Google Calendar and Gmail through
OAuth, synchronizes selected records to HubSpot, and receives the production
OpenAI phone webhook used by the telephony path.

## Cloudflare staging architecture

- Cloudflare Worker and Workers Static Assets serve the application and API.
- OpenAI Realtime remains the AI and browser voice provider.
- One SQLite-backed Durable Object per phone call owns the server-side Realtime
  WebSocket and persisted webhook/function-call idempotency.
- A private R2 bucket stores booking, check-in, career-session, and event JSONL
  records with conditional writes.
- The staging Worker has no production route or custom domain.
- GCP production, DNS, Twilio, and the production OpenAI webhook are unchanged.

## Completed and validated

- Browser application and OpenAI Realtime WebRTC session creation.
- Booking creation, lookup, cancellation, and check-in persistence.
- Career lookup, prior-session memory, and career-summary persistence.
- Event configuration, participant and mentor intake, participant lookup,
  event check-in, and recap submission for organizer review.
- Google OAuth token refresh, Calendar availability, invitation creation,
  cancellation, and consent-based Gmail career follow-up delivery.
- Access-gated organizer review, idempotent approval, and consent-aware event
  follow-up delivery. The path-based Access application still requires
  dashboard configuration and a live authentication test.
- R2 diagnostics that expose object existence and size without participant data.
- Thirty automated tests, including Cloudflare phone signature validation,
  deterministic Durable Object routing, duplicate handling, original phone
  end-to-end behavior, privacy, and migrated public workflows.

## Cloudflare resources

- Worker: `pierce-voice-cloudflare-staging`
- R2 bucket: `pierce-voice-staging-data`
- Durable Object: `PiercePhoneCall` through the `PHONE_CALLS` binding
- Worker secret: `OPENAI_API_KEY`
- Staging URL: `https://pierce-voice-cloudflare-staging.piercefund.workers.dev`

## Remaining production gates

1. Configure the path-based Cloudflare Access application and validate organizer
   sign-in, approval, and follow-up delivery from staging.
2. Add the OpenAI webhook-signing secret and test the implemented Durable Object
   phone path with an isolated non-production webhook and phone route.
3. Exercise HubSpot Queue retries and dead-letter handling under staging
   failures.
4. Define retention, export, backup, and deletion policy for participant data in
   R2 before production use.
5. Complete staging end-to-end tests for external integrations and failure
   recovery.
6. Obtain explicit approval before changing DNS, the production domain, Twilio,
   OpenAI webhooks, or GCP traffic.

## Secrets still required

Set secrets with `wrangler secret put NAME --env staging`; never commit values.

- `OPENAI_WEBHOOK_SECRET` is still required to activate the staging phone
  webhook. The other migrated integrations already have named staging secrets.

The Google client ID, callback URI, API bases, model names, and feature flags are
non-secret environment configuration. GCP-only storage credentials must not be
copied to Cloudflare.

## Cutover status

Cloudflare staging is functional for browser voice, R2-backed workflows,
Calendar/Gmail, organizer approval, and queued HubSpot synchronization. The
phone runtime is implemented but remains inactive until the webhook-signing
secret and isolated staging webhook are configured and tested. No production
cutover should occur until those gates are completed or explicitly removed.
