# Pierce Voice GCP Production Inventory

Audit snapshot: November 22, 2026 at 8:48 PM PST
GCP project: `pierce-voice-calendar`
Production hostname: `voice.pierce.fund`

## Executive summary

`voice.pierce.fund` is still served by Google Cloud. DNS points to Google Frontend, which routes the custom domain to the public Cloud Run service `pierce-voice` in `us-west1`. The service showed live requests and one running instance during this audit.

The request-path production dependency set is one Cloud Run service, one runtime Cloud Storage bucket, five Secret Manager secrets, and Google Calendar/Gmail/OAuth APIs. The source deployment also depends on a second Cloud Storage bucket, Cloud Build, and Artifact Registry. No Cloud Run Jobs, Cloud Scheduler jobs, separate Cloud Functions, Cloud SQL connections, or mounted volumes were found.

Do not retire any item in this inventory until Cloudflare has carried real browser and phone traffic cleanly and a rollback window has passed.

## Live request path

1. `voice.pierce.fund` resolves through the CNAME `ghs.googlehosted.com`.
2. Google Frontend terminates the public HTTPS request.
3. The Cloud Run domain mapping sends the request to `pierce-voice` in `us-west1`.
4. The Cloud Run service URL is `https://pierce-voice-112314776424.us-west1.run.app`.
5. The service reads and writes application records in `gs://pierce-voice-calendar-pierce-data/pierce-data/`.
6. It uses Google OAuth credentials to call Calendar and Gmail, and it reads runtime credentials from Secret Manager.

## GCP services and resources production depends on

| Category | Resource | Region / scope | Production role | Cutover treatment |
|---|---|---|---|---|
| Cloud Run | Service `pierce-voice` | `us-west1` | Serves `voice.pierce.fund`, browser routes, phone webhook, static assets, booking/check-in, career sessions, follow-up email, event workflows, and HubSpot sync. Public ingress is enabled. | Keep live until Cloudflare passes browser and real-call verification. Retain during rollback window. |
| Cloud Run | Custom domain mapping `voice.pierce.fund` → `pierce-voice` | Global DNS / `us-west1` service | Current production hostname mapping and TLS path. | Replace only during the verified DNS cutover. |
| Cloud Storage | Bucket `pierce-voice-calendar-pierce-data` | `us-west1`, Standard, private, uniform access | Runtime JSONL storage under prefix `pierce-data`: booking requests, check-ins, career-session summaries, follow-up email records, HubSpot sync records, event intake/check-in/summary records, and job-fair quick starts. | Export/reconcile into the private R2 target before shutdown; preserve until data verification and rollback window complete. |
| Secret Manager | `pierce-openai-api-key` | Project | Injects `OPENAI_API_KEY` into Cloud Run. | Keep until OpenAI-dependent production paths are removed and verified. Never copy values into reports or source control. |
| Secret Manager | `pierce-openai-webhook-secret` | Project | Authenticates the OpenAI Realtime webhook. | Keep until live speech is migrated and verified. |
| Secret Manager | `pierce-google-client-secret` | Project | Google OAuth web-client credential for Calendar/Gmail. | Recreate securely for the Cloudflare runtime or replace with the final auth design before GCP retirement. |
| Secret Manager | `pierce-google-calendar-refresh-token` | Project | Authorizes Calendar event and Gmail send calls for `voice@pierce.fund`. | Recreate securely outside GCP or replace before GCP retirement; test both calendar invitations and email recaps. |
| Secret Manager | `pierce-hubspot-service-key` | Project | Authorizes HubSpot synchronization. | Recreate securely in Cloudflare and verify sync before removal. |
| Google Calendar API | Calendar events and free/busy APIs | Google Workspace / project OAuth client | Availability checks, invitations, rescheduling, and cancellation. | Preserve scopes and behavior; verify a full booking lifecycle after migration. |
| Gmail API | Gmail send API | Google Workspace / project OAuth client | Sends participant follow-up emails and recaps from `voice@pierce.fund`. | Preserve `gmail.send` authorization and verify delivery after migration. |
| Google OAuth 2.0 / OpenID Connect | OAuth client, token endpoint, userinfo endpoint, redirect `https://voice.pierce.fund/calendar/oauth/callback` | Project / Google identity | Connects Calendar and Gmail and validates the mailbox identity. | Update the authorized redirect only after the Cloudflare callback is ready; confirm connected and email-connected status. |
| IAM / service identity | Cloud Run runtime service identity and bucket permissions | Project | Allows the service to read/write the runtime bucket and access bound secrets. | Keep until all GCP runtime access is no longer needed. |

## Build and deployment resources

These are not in the live request path, but they are required to rebuild or roll back the current GCP production service.

| Category | Resource | Region | Role |
|---|---|---|---|
| Cloud Storage | `run-sources-pierce-voice-calendar-us-west1` | `us-west1` | Source archive bucket used by Cloud Run source deployments. |
| Artifact Registry | Repository `cloud-run-source-deploy` | `us-west1` | Stores the deployed Cloud Run container image. The audited revision used image digest `sha256:fa3eaeab8a106558de3386c2600b0be518bb72558467f113767b053d6ce4e670`. |
| Cloud Build | Source build invoked by Cloud Run deployment | Project / `us-west1` deployment workflow | Builds the container from repository source before Cloud Run deployment. |

## Production configuration that must be preserved

- Public URL: `https://voice.pierce.fund`
- Calendar owner and Google account: `voice@pierce.fund`
- OAuth callback: `https://voice.pierce.fund/calendar/oauth/callback`
- Storage bucket and prefix: `pierce-voice-calendar-pierce-data` / `pierce-data`
- Research pass currently enabled with model `gpt-5`
- OpenAI Realtime model currently `gpt-realtime-2.1`
- Phone webhook path: `/webhooks/openai/realtime`
- Runtime port: `8080`
- Current service configuration: 512 MiB memory, 1 CPU, TCP startup probe on port 8080, one always-on instance in the documented deployment configuration

## External dependencies reached from the GCP service

These are not GCP resources, but production behavior will fail or degrade if they are omitted during cutover:

- OpenAI API and Realtime WebSocket for the current live voice path and optional career research pass.
- HubSpot API for contact and activity synchronization.
- Google Workspace Calendar and Gmail data accessed through the project OAuth client.
- Twilio toll-free number and messaging/telephony configuration used by the broader Pierce phone flow.

## Confirmed absent or unused

- Cloud Run Jobs: none listed.
- Cloud Scheduler: API not enabled; no scheduler jobs found.
- Separate Cloud Functions: none found; the console resolves this project to the single Cloud Run service.
- Cloud SQL: no connection configured on the service.
- Mounted Cloud Run volumes: none configured.
- Additional Cloud Run services: none found.

## Cutover checklist derived from this inventory

1. Port every route now served by `pierce-voice`, including the OAuth callback and OpenAI phone webhook.
2. Copy and reconcile all runtime records from `gs://pierce-voice-calendar-pierce-data/pierce-data/` into the approved Cloudflare data stores without copying raw audio or full transcripts.
3. Recreate required secrets in Cloudflare using secret storage; never place secret values in source control or migration reports.
4. Verify Calendar availability, invitation, reschedule, and cancellation behavior.
5. Verify Gmail recap delivery and HubSpot synchronization.
6. Verify browser traffic, TLS, OAuth callback behavior, and a real phone call on Cloudflare before changing DNS.
7. Preserve the Cloud Run service, source bucket, runtime bucket, Artifact Registry image, and secrets through the agreed rollback window.
8. After Cloudflare has carried real calls cleanly, rotate or revoke credentials that no longer need GCP access, then decommission the resources under Task 7.

## Operational risk found during audit

The Google Cloud console displayed a free-trial warning with approximately four days remaining at the time of audit. Billing continuity should be confirmed immediately so the current production service does not stop before Cloudflare cutover is complete.

## Verification performed

- Confirmed `voice.pierce.fund` resolves to `ghs.googlehosted.com` and returns HTTP 200 from Google Frontend.
- Confirmed the Cloud Run domain mapping points `voice.pierce.fund` to `pierce-voice` in `us-west1`.
- Confirmed the service showed active production requests and one active instance.
- Inspected the deployed container, environment variables, secret bindings, service URL, ingress, custom domain, and runtime configuration.
- Inspected Cloud Storage and confirmed the runtime and source-deployment buckets.
- Confirmed the Artifact Registry image used by the deployed revision.
- Checked Cloud Run Jobs, Cloud Scheduler, Cloud Functions, Cloud SQL connections, mounted volumes, and additional Cloud Run services.
- Reconciled the console inventory against `README.md` deployment instructions and `server.mjs` runtime API usage.

## Open items

- Confirm the GCP billing account will remain active until the verified Cloudflare cutover and rollback window are complete.
- Before Task 7, capture a final object count/checksum or equivalent reconciliation for the runtime bucket and record the final Cloud Run revision receiving traffic.
