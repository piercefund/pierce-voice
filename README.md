# Pierce Voice

Pierce is a Cloudflare Workers application for booking, check-in, event support,
and focused 15-minute career guidance. Quiet Mode uses IBM Granite 4.0 H Micro
through Workers AI. The current live speech path still uses OpenAI Realtime while
the separate ElevenLabs migration is completed.

## Setup

1. Use Node.js 20 or newer.
2. Set your OpenAI API key:

   ```bash
   export OPENAI_API_KEY="sk-..."
   ```

   To sync approved guest records to HubSpot, also set the account Service Key:

   ```bash
   export HUBSPOT_SERVICE_KEY="your-hubspot-service-key"
   ```

3. To create Google Calendar invitations from `voice@pierce.fund`, also set the Google OAuth web-client credentials described in [Calendar Auth](#calendar-auth).
4. Start the server:

   ```bash
   npm start
   ```

5. Open http://localhost:3000, choose `Book` or `Check In`, and allow microphone access. A checked-in guest can then start their career session without repeating their identity or booking lookup.
6. Use the primary button to begin. Pierce ends the voice session automatically after a successful close; `End` remains available if a guest needs to stop early.

## Cloudflare production

Production runs as the `pierce-voice-cloudflare` Worker configured by
[`wrangler.jsonc`](./wrangler.jsonc). The architecture uses:

- Workers and Static Assets for the application and API.
- Workers AI with `@cf/ibm-granite/granite-4.0-h-micro` for the small-model
  career-session path.
- Private R2 buckets for structured records. Raw audio and full verbatim
  transcripts are not stored in Pierce-controlled storage.
- A per-call SQLite Durable Object for temporary phone state. Its retention
  deadline is set when the call begins and temporary state is deleted within
  24 hours.
- Cloudflare Access for organizer and review routes.
- Queues for HubSpot synchronization.

Install dependencies, run the test suite, and perform a dry run before a
production deployment:

```bash
npm ci
npm test
npx wrangler deploy --dry-run
```

Deploy the top-level production environment only after its bindings and secrets
have been verified:

```bash
npx wrangler deploy
```

Never put secret values in `wrangler.jsonc`, `.dev.vars.example`, source files,
or Git history. Production secrets are configured through Cloudflare's secret
store. `.dev.vars` is ignored and is only for local development.

The production Worker expects the R2, Durable Object, Queue, Workers AI, and
Static Assets bindings declared in `wrangler.jsonc`. The separately deployed
staging environment is selected with `--env staging`; do not use staging data or
bindings for production tests.

Before a DNS cutover, verify the Worker on its `workers.dev` hostname, including
health, persistence, Calendar/Gmail, signed phone webhooks, and Access-protected
organizer routes. Keep the previous Google Cloud Run service intact as a
rollback origin until the separately approved decommission task.

## City Highlights Pilot

The September pilot adds four focused Pierce functions while preserving the regular booking, check-in, and career-session experience:

1. **Participant intake:** open http://localhost:3000/events/city-highlights-careers. Pierce collects contact details, recording and information-sharing consent, city, career stage, goal, challenge, and exactly two mentor questions.
2. **Event check-in:** open http://localhost:3000/events/city-highlights-careers/check-in. Pierce confirms the participant and marks them present. Event check-in does not start a regular 15-minute career session.
3. **Structured recap:** a facilitator opens http://localhost:3000/recap after the mentor conversation. Pierce captures up to two guidance points, one mentor connection, one event, one resource, and one next step with an owner and date.
4. **Follow-up and HubSpot:** the organizer reviews pending recaps at http://localhost:3000/organizer. Approved recaps are emailed only when the participant consented, then the final event record is added to HubSpot.

Mentors can prepare separately at http://localhost:3000/mentor. Public event pages show only `Prepare` and `Check In`; the mentor, facilitator, and organizer links are direct operational paths.

For a public deployment, replace `http://localhost:3000` with `https://voice.pierce.fund`. The event can be renamed without code changes:

```bash
export PIERCE_EVENT_NAME="City Highlights for Careers"
export PIERCE_EVENT_DATE_LABEL="September 2026"
export PIERCE_EVENT_LOCATION_LABEL="Cafe location shared with participants"
```

Event records are stored in `work/event-intakes.jsonl`, `work/event-check-ins.jsonl`, and `work/event-session-summaries.jsonl` locally, or in the private `PIERCE_DATA` R2 bucket on Cloudflare. Keep the `work/` folder private and persistent when running locally. Deployed organizer and review routes require an authenticated Cloudflare Access identity.

## Phone Setup

Pierce can also answer the Twilio number `+1 866-967-2844` (`1-86-OWNPATH-4`) through OpenAI Realtime SIP. The browser experience and phone calls use the same booking, check-in, and career-session handlers.

1. In the OpenAI project, create a webhook for `realtime.call.incoming` with this endpoint:

   ```text
   https://voice.pierce.fund/webhooks/openai/realtime
   ```

2. Copy the webhook signing secret once, then start Pierce with both server secrets:

   ```bash
   export OPENAI_API_KEY="sk-..."
   export OPENAI_WEBHOOK_SECRET="whsec_..."
   npm start
   ```

3. For a temporary local test, point ngrok at Pierce and use its HTTPS address in the OpenAI webhook:

   ```bash
   ngrok http 3000
   ```

   For example: `https://your-ngrok-domain.ngrok-free.app/webhooks/openai/realtime`. Update the webhook whenever a temporary ngrok address changes.

4. Keep the Twilio Elastic SIP trunk origination URI pointed at the OpenAI project and use TLS:

   ```text
   sip:proj_YOUR_PROJECT_ID@sip.api.openai.com;transport=tls
   ```

Optional phone settings are `PIERCE_PHONE_VOICE` (defaults to `marin`) and `PIERCE_PHONE_HANGUP_GRACE_MS` (defaults to `7000`). The phone model is fixed to `gpt-realtime-2.1`. Browser and phone audio use near-field noise reduction and balanced semantic turn detection. Automatic interruption is disabled so background sounds do not cut Pierce off.

On an incoming call, the signed webhook accepts the supplied `call_id`, opens the server WebSocket, and lets the caller choose booking, check-in, or career guidance. A successful check-in can continue into the career session in the same call using the single check-in plus career consent. Calls close only after the final spoken confirmation and playback grace period.

## What It Does

- The browser captures microphone audio and plays model audio with `RTCPeerConnection`.
- The browser creates an `oai-events` data channel.
- The server accepts the browser SDP at `POST /session`.
- The server verifies signed OpenAI phone events at `POST /webhooks/openai/realtime`.
- The server forwards that SDP to `https://api.openai.com/v1/realtime/calls` using multipart `FormData` fields named `sdp` and `session`.
- In booking mode, the browser registers email verification, existing-booking lookup, cancellation, and booking-request tools with `session.update`.
- In check-in mode, the browser registers `find_guest_session(guest_name, date)` and `prepare_check_in_request(guest_name, recording_consent, date, session_time, topic, booking_request_id)` with `session.update`.
- In career mode, Pierce finds the guest's booking, asks for their city, checks whether they are ages 14 to 24 for San Diego youth-program guidance, asks exactly four discovery questions, recommends one SCORE mentor connection, exactly one locally relevant event, and one approved resource, then confirms one next step and date.
- Career session summaries are saved to `work/career-session-summaries.jsonl` locally, or to the private `PIERCE_DATA` R2 bucket on Cloudflare.
- Returning career sessions can include one follow-up question about the prior confirmed next step after the guest confirms the exact booking email. Pierce saves the answer with the new session.
- With consent, Pierce sends the career summary from `voice@pierce.fund` and records the delivery in `work/follow-up-emails.jsonl`. The subject reflects the career focus and session occurrence. If Gmail delivery is unavailable, the record is kept with status `pending_delivery` instead of being lost.
- Career summaries stay out of the calendar invitation; the invitation remains focused on the appointment and check-in link.
- Pierce selects exactly one resource from My Next Move, CareerOneStop, O*NET OnLine, SBCS, SDSU Careers, International Rescue Committee San Diego, and Climb Hire San Diego. Youth-program recommendations must preserve eligibility caveats.
- Pierce uses SCORE as the default retired-expert mentor pathway and stores the guest's preference for online, local in-person, or either.
- When a live event listing is not verified, Pierce recommends an event type and does not invent an organizer, date, location, or link.
- Pierce collects email in parts, reads every character and punctuation mark back, and replaces the earlier value completely whenever the guest corrects it.
- After the exact email is confirmed, Pierce checks for active bookings. A guest can keep, cancel, or replace an existing session, and the server prevents a second active booking from being saved.
- Pierce starts with "Hi, welcome," gets recording consent first, leads one question at a time, and says a session is booked only after Google confirms the event and invitation.
- Successful bookings and pending fallback requests are recorded in `work/booking-requests.jsonl` locally, or to the private `PIERCE_DATA` R2 bucket on Cloudflare.
- Check-ins ask for recording consent and the booking name, look up matching saved sessions, read back the date, time, and reason, then write pending admin updates to `work/check-in-requests.jsonl` locally, or to the private `PIERCE_DATA` R2 bucket on Cloudflare.
- Lookup times are shown and spoken in 12-hour Pacific time, such as `1:00 PM`.
- After a successful check-in, the app carries the confirmed booking into `Career Session`, presents `Start career session`, and does not ask the guest to identify themselves again. The 15-minute timer begins only when the guest starts it.
- On phone calls, Pierce asks one combined consent for check-in plus the career session when the caller checks in and continues in the same call. In the browser flow, check-in and career session remain separate screens with clear consent prompts.
- Automatic ending waits for the final response to finish and adds a playback grace period so check-in closings and next-step confirmations are not cut off.
- Queue records include `queue_type` and a `check_in` flag: bookings use `check_in: false`; check-ins use `check_in: true`.
- A check-in record includes an admin calendar note like `Admin note: Guest checked in at Jul 21, 2026, 1:05 PM.`
- Spoken emails such as `jane at example dot com` are normalized and validated before a request is saved.
- Gmail addresses are matched by mailbox identity for the one-booking rule, so dots in the local part do not let the same guest create duplicate active bookings. The invitation still uses the exact address the guest confirmed.
- Known capture corrections handle recurring misses like `Curling Robinson` -> `Kurling Robinson`, `Natasha Duttal` -> `Natasha Dhital`, and `focus.com` -> `fokcus.com`.
- With Google OAuth connected, the server checks FreeBusy, creates the event with a deterministic ID, and uses `sendUpdates=all` so the guest receives the invitation. The event has no Google Meet conference or map location, and its formatted description links to `https://voice.pierce.fund/check-in`, which opens Pierce with Check In selected. The older `?mode=check-in` address remains supported. If Calendar is not connected or temporarily fails, the request stays in the existing operator queue.

## Calendar Auth

Pierce uses a server-side OAuth refresh token. Do not use or expose a temporary `GOOGLE_CALENDAR_ACCESS_TOKEN`.

1. In Google Cloud, enable the Google Calendar API, configure the OAuth consent screen, and create an OAuth client with application type `Web application`.
2. Add this exact authorized redirect URI to the OAuth client:

   ```text
   http://localhost:3000/calendar/oauth/callback
   ```

3. Start Pierce with the OAuth client credentials:

   ```bash
   export GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
   export GOOGLE_CLIENT_SECRET="your-client-secret"
   export PIERCE_CALENDAR_OWNER_EMAIL="voice@pierce.fund"
   npm start
   ```

4. On the Pierce computer, open http://localhost:3000/calendar/connect, choose `voice@pierce.fund`, and approve Calendar access.
5. Confirm http://localhost:3000/calendar/status reports `"connected": true` and `"connected_account": "voice@pierce.fund"`.

The long-lived refresh token is written with owner-only permissions to the ignored file `work/google-calendar-oauth.json`. The browser and Realtime model never receive it. Keep `work/` private and persistent. A deployed secret store can instead provide `GOOGLE_CALENDAR_REFRESH_TOKEN` and `GOOGLE_CALENDAR_ACCOUNT_EMAIL=voice@pierce.fund`.

New records default to `voice@pierce.fund`. `GOOGLE_CALENDAR_ID` defaults to `primary`; change it only when Pierce should use a specific shared calendar. Existing queue and archive records keep the owner email recorded when they were created.

If Google Calendar is not connected, Pierce preserves the previous operator-assisted flow. Ask Codex to complete the latest pending booking request using the connected Google Calendar plugin.

After Pierce captures a check-in, ask Codex to complete the latest check-in. Codex will read `work/check-in-requests.jsonl`, find the matching event on Pierce's calendar, and add the admin check-in note to the event description.

Career follow-up email uses the same Google OAuth connection as Calendar and requires the Gmail API plus the `gmail.send` permission. After updating from an older connection, visit http://localhost:3000/calendar/connect and approve access again. Confirm http://localhost:3000/calendar/status reports both `"connected": true` and `"email_connected": true`.

When `HUBSPOT_SERVICE_KEY` is configured, every accepted booking automatically creates or updates the contact by confirmed email, adds an idempotent booking note with the Tourist journey stage, and records the HubSpot IDs in `work/hubspot-syncs.jsonl`. HubSpot errors never undo the booking or calendar invitation. `POST /hubspot/sync/latest-booking` remains available as a safe manual retry.

After Pierce completes a career session, the calendar invitation stays unchanged. The guest receives the concise goal, SCORE mentor connection, event, resource, and confirmed next step by email when they approve it.
