# Pierce Phone Channel Sprint Checklist

## Sprint Goal

Enable a guest to call Pierce, choose booking, check-in, or career guidance, complete the same workflow available in the web app, and end the call cleanly.

## Completed Setup

- [x] Fund the Twilio account.
- [x] Submit the Twilio Business Profile.
- [x] Receive Business Profile approval.
- [x] Confirm the existing Pierce web experience works locally.

## 1. Secure the Phone Number

- [x] Choose the toll-free number `+1 866-967-2844` (`1-86-OWNPATH-4`).
- [x] Confirm the selected number supports Voice.
- [ ] Add SMS capability only if text confirmations are part of this sprint.
- [ ] Review the monthly and per-minute price before purchasing.
- [x] Purchase the number and record the public number without storing credentials in the repository.

## 2. Prepare the Public Endpoint

- [x] Choose ngrok as the temporary HTTPS tunnel for testing.
- [ ] Confirm the public URL reaches the Pierce server.
- [ ] Add `OPENAI_WEBHOOK_SECRET` to the server environment.
- [ ] Keep `OPENAI_API_KEY`, Twilio credentials, and webhook secrets out of Git.
- [ ] Create an OpenAI Project webhook for `realtime.call.incoming`.
- [ ] Point the webhook to the new Pierce incoming-call endpoint.

## 3. Configure Twilio SIP

- [x] Create an Elastic SIP Trunk named `Pierce Realtime`.
- [x] Find and record the OpenAI Project ID beginning with `proj_`.
- [x] Add the Origination URI:

  ```text
  sip:proj_YOUR_PROJECT_ID@sip.api.openai.com;transport=tls
  ```

- [x] Associate the purchased Twilio number with the SIP trunk.
- [x] Confirm the trunk and number are enabled for inbound calls.

## 4. Add the Phone Channel to Pierce

- [x] Add a server endpoint for signed OpenAI incoming-call webhooks.
- [x] Verify every OpenAI webhook signature before processing it.
- [x] Ignore duplicate webhook deliveries safely.
- [x] Accept approved calls through the Realtime Calls API using `gpt-realtime-2`.
- [x] Open the server WebSocket using the incoming `call_id`.
- [x] Have Pierce greet the caller and ask whether they want to book, check in, or begin a career session.
- [x] Load the correct existing Pierce instructions after the caller chooses a path.
- [x] Reuse the existing booking, check-in, career-session, queue, calendar-update, and HubSpot behavior.
- [x] Preserve both required consent moments for check-in and career sessions.
- [x] Execute function calls on the server and return results to the Realtime session.
- [x] End the phone call only after Pierce finishes the complete closing response.
- [x] Add clear server logs without recording secrets or full guest details.

## 5. End-to-End Tests

- [ ] Call the number and hear Pierce's welcome without excessive delay.
- [ ] Complete a new 15-minute booking request.
- [ ] Correct a misspelled name and email during booking.
- [ ] Confirm a second active booking is prevented or replaced with consent.
- [ ] Check in using only the booked name.
- [ ] Hear the matching date, time, and session reason before confirming check-in.
- [ ] Complete a career session with city, four discovery questions, two recommendations, and one confirmed next step.
- [ ] Confirm the calendar-note and follow-up-email permissions are collected separately.
- [ ] Confirm the booking, check-in, and career records appear in their queues.
- [ ] Confirm HubSpot receives the expected guest journey update when configured.
- [ ] Confirm Pierce finishes speaking before the call disconnects.
- [ ] Confirm declining recording consent ends the flow politely without saving a request.
- [ ] Confirm the existing browser experience still works after the phone changes.

## 6. Launch Readiness

- [x] Add the phone environment variables to the setup instructions.
- [x] Document how to start the server and public HTTPS endpoint.
- [ ] Document how to disable the SIP trunk or detach the number quickly.
- [ ] Set a small Twilio spending alert and review OpenAI usage limits.
- [ ] Remove test guest records or clearly label them as tests.
- [ ] Complete one final call from a phone not associated with the Twilio account.

## Definition of Done

- [ ] A guest can call the public number and choose one of Pierce's three journeys.
- [ ] All three journeys use the same validated records and rules as the web app.
- [ ] Calls end naturally after Pierce's closing statement.
- [ ] No API keys, authentication tokens, webhook secrets, or private identity records are committed to Git.
- [ ] Setup, testing, rollback, and known limitations are documented.

## Optional Follow-Up Sprint

- [ ] Complete toll-free SMS verification.
- [ ] Send booking and check-in confirmations by text.
- [ ] Add multilingual language selection.
- [ ] Add human transfer for callers who need staff assistance.
- [ ] Add call-quality, completion-rate, and drop-off reporting.
- [ ] Replace the temporary number if the preferred Pierce vanity number becomes available.

## Reference Guides

- [OpenAI Realtime API with SIP](https://developers.openai.com/api/docs/guides/realtime-sip)
- [Twilio and OpenAI Elastic SIP Trunking](https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking)
