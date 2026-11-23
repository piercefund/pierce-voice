import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { handleRequest, PierceEmailLink, PiercePhoneCall } from "../src/cloudflare-worker.mjs";
import { processHubspotQueue } from "../src/cloudflare-hubspot.mjs";
import { validateTwilioSignature } from "../src/cloudflare-sms.mjs";

class MockR2Bucket {
  #objects = new Map();
  #version = 0;

  async get(key) {
    const object = this.#objects.get(key);
    if (!object) return null;
    return { etag: object.etag, text: async () => object.text };
  }

  async head(key) {
    const object = this.#objects.get(key);
    if (!object) return null;
    return { etag: object.etag, size: new TextEncoder().encode(object.text).byteLength };
  }

  async put(key, value, options = {}) {
    const current = this.#objects.get(key);
    const ifMatch = options.onlyIf?.etagMatches;
    const ifNoneMatch = options.onlyIf?.etagDoesNotMatch;
    if (ifMatch && current?.etag !== ifMatch) return null;
    if (ifNoneMatch === "*" && current) return null;
    this.#version += 1;
    const stored = { text: String(value), etag: `etag-${this.#version}` };
    this.#objects.set(key, stored);
    return { etag: stored.etag };
  }
}

class MockQueue {
  messages = [];

  async send(body, options) {
    this.messages.push({ body, options });
  }
}

class MockDurableStorage {
  values = new Map();
  alarm = null;

  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async deleteAll() { this.values.clear(); this.alarm = null; }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
}

class MockPhoneSocket {
  listeners = new Map();
  sent = [];
  closed = false;

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }

  async emit(type, data = undefined) {
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }
}

function phoneWebhookHeaders(body, webhookId, secret, valid = true) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", valid ? secret : "wrong-secret")
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`
  };
}

function twilioWebhookRequest(params, authToken, valid = true) {
  const url = "https://staging.example/webhooks/twilio/messaging";
  const form = new URLSearchParams(params);
  const names = [...new Set(form.keys())].sort();
  let signed = url;
  for (const name of names) {
    for (const value of form.getAll(name).sort()) signed += `${name}${value}`;
  }
  const signature = createHmac("sha1", valid ? authToken : "wrong-token")
    .update(signed)
    .digest("base64");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature
    },
    body: form
  });
}

function testEnv(overrides = {}) {
  return {
    PIERCE_ENV: "staging",
    OPENAI_API_BASE: "https://api.openai.test",
    OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
    ASSETS: {
      fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`);
      }
    },
    ...overrides
  };
}

function attachEmailLinkNamespace(env) {
  const objects = new Map();
  env.EMAIL_LINKS = {
    getByName(name) {
      if (!objects.has(name)) {
        const storage = new MockDurableStorage();
        objects.set(name, {
          storage,
          instance: new PierceEmailLink({ storage }, env)
        });
      }
      return objects.get(name).instance;
    }
  };
  return objects;
}

function jsonRequest(path, body) {
  return new Request(`https://staging.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function accessContext(email = "organizer@pierce.fund") {
  return {
    access: {
      aud: "pierce-organizer-test",
      async getIdentity() {
        return { email, name: "Pierce Organizer" };
      }
    }
  };
}

test("reports staging capabilities without touching external services", async () => {
  const response = await handleRequest(
    new Request("https://staging.example/__cloudflare/health"),
    testEnv()
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "pierce-voice",
    environment: "staging",
    capabilities: {
      static_assets: true,
      browser_realtime_session: true,
      booking_check_in_persistence: false,
      career_session_persistence: false,
      event_persistence: false,
      mentor_scheduling: false,
      google_calendar_gmail: false,
      organizer_access: false,
      hubspot_queue: false,
      stateful_workflows: false,
      phone_webhook: false,
      secure_email_links: false,
      onet_career_explorer: false,
      one_time_sms: false,
      elevenlabs_custom_llm: false
    }
  });
});

test("verifies and routes incoming OpenAI phone calls to one durable object", async () => {
  const secret = "test-phone-webhook-secret";
  const routed = [];
  const env = testEnv({
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_WEBHOOK_SECRET: secret,
    PHONE_CALLS: {
      getByName(name) {
        assert.equal(name, "call-cloudflare-1");
        return {
          async fetch(request) {
            routed.push(await request.json());
            return Response.json({ ok: true });
          }
        };
      }
    }
  });
  const body = JSON.stringify({
    id: "event-cloudflare-1",
    type: "realtime.call.incoming",
    data: {
      call_id: "call-cloudflare-1",
      sip_headers: [
        { name: "From", value: "sip:+18669672844@sip.example.com" },
        { name: "To", value: "sip:+18005551212@sip.example.com" }
      ]
    }
  });

  const rejected = await handleRequest(new Request(
    "https://staging.example/webhooks/openai/realtime",
    { method: "POST", headers: phoneWebhookHeaders(body, "webhook-bad", secret, false), body }
  ), env);
  assert.equal(rejected.status, 400);
  assert.equal(routed.length, 0);

  const accepted = await handleRequest(new Request(
    "https://staging.example/webhooks/openai/realtime",
    { method: "POST", headers: phoneWebhookHeaders(body, "webhook-good", secret), body }
  ), env);
  assert.equal(accepted.status, 200);
  assert.deepEqual(routed, [{
    call_id: "call-cloudflare-1",
    webhook_id: "webhook-good",
    caller_phone: "+18669672844"
  }]);
});

test("acknowledges the OpenAI dashboard's synthetic incoming-call event", async () => {
  const secret = "test-phone-webhook-secret";
  let routed = false;
  const env = testEnv({
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_WEBHOOK_SECRET: secret,
    PHONE_CALLS: {
      getByName() {
        routed = true;
        throw new Error("Synthetic dashboard calls must not be routed");
      }
    }
  });
  const body = JSON.stringify({
    id: "event-dashboard-test",
    type: "realtime.call.incoming",
    data: { call_id: "rtc_u0_abc123" }
  });

  const response = await handleRequest(new Request(
    "https://staging.example/webhooks/openai/realtime",
    { method: "POST", headers: phoneWebhookHeaders(body, "webhook-dashboard-test", secret), body }
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, test: true });
  assert.equal(routed, false);
});

test("validates Twilio messaging webhooks and handles HELP and STOP", async () => {
  const authToken = "twilio-webhook-test-token";
  const env = testEnv({ TWILIO_AUTH_TOKEN: authToken });

  const invalid = await handleRequest(twilioWebhookRequest({
    From: "+16195550100",
    To: "+18669672844",
    Body: "HELP"
  }, authToken, false), env);
  assert.equal(invalid.status, 403);

  const help = await handleRequest(twilioWebhookRequest({
    From: "+16195550100",
    To: "+18669672844",
    Body: "HELP"
  }, authToken), env);
  assert.equal(help.status, 200);
  assert.match(await help.text(), /email voice@pierce\.fund or call 1-866-967-2844/);

  const stop = await handleRequest(twilioWebhookRequest({
    From: "+16195550100",
    To: "+18669672844",
    Body: "STOP"
  }, authToken), env);
  assert.equal(stop.status, 200);
  assert.match(await stop.text(), /You have been unsubscribed/);

  const advancedOptOut = await handleRequest(twilioWebhookRequest({
    From: "+16195550100",
    To: "+18669672844",
    Body: "HELP",
    OptOutType: "HELP"
  }, authToken), env);
  assert.equal(advancedOptOut.status, 200);
  assert.doesNotMatch(await advancedOptOut.text(), /<Message>/);
});

test("matches Twilio's published webhook signature test vector", async () => {
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const rawBody = new URLSearchParams({
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675310",
    Digits: "1234",
    From: "+14158675310",
    To: "+18005551212"
  }).toString();
  const request = new Request(url, {
    method: "POST",
    headers: { "x-twilio-signature": "L/OH5YylLD5NRKLltdqwSvS0BnU=" }
  });
  assert.equal(await validateTwilioSignature(request, rawBody, "12345"), true);
});

test("durable phone call accepts once and persists function-call idempotency", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let accepts = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (url === "https://api.openai.test/v1/realtime/calls/call-durable-1/accept") {
      accepts += 1;
      const session = JSON.parse(init.body);
      assert.equal(session.model, "gpt-realtime-2.1");
      assert.equal(session.audio.output.voice, "marin");
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const storage = new MockDurableStorage();
  const pending = [];
  const socket = new MockPhoneSocket();
  const call = new PiercePhoneCall({
    storage,
    waitUntil(promise) { pending.push(promise); }
  }, testEnv({
    OPENAI_API_KEY: "test-openai-key",
    PIERCE_DATA: new MockR2Bucket(),
    PHONE_WEBSOCKET_CONNECT: async (callId) => {
      assert.equal(callId, "call-durable-1");
      return socket;
    }
  }));
  const incoming = () => call.fetch(jsonRequest("/incoming", {
    call_id: "call-durable-1",
    webhook_id: "webhook-durable-1"
  }));

  const first = await incoming();
  assert.equal(first.status, 200);
  assert.equal(accepts, 1);
  assert.deepEqual(socket.sent[0], { type: "response.create" });

  const duplicate = await incoming();
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(accepts, 1);

  const functionEvent = JSON.stringify({
    type: "response.function_call_arguments.done",
    response_id: "response-select",
    call_id: "function-select",
    name: "select_pierce_journey",
    arguments: JSON.stringify({ journey: "book" })
  });
  await socket.emit("message", functionEvent);
  await Promise.all(pending.splice(0));
  await socket.emit("message", functionEvent);
  await Promise.all(pending.splice(0));

  assert.equal(
    socket.sent.filter((event) =>
      event.type === "conversation.item.create" && event.item.call_id === "function-select"
    ).length,
    1
  );
  const sessionUpdate = socket.sent.find((event) => event.type === "session.update");
  assert.ok(sessionUpdate.session.tools.some((tool) => tool.name === "prepare_booking_request"));
  assert.equal(await storage.get("journey"), "book");
  assert.ok(await storage.get("function:function-select"));
});

test("phone walk-in uses caller ID for a first name and skips appointment booking", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bucket = new MockR2Bucket();
  const date = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const env = testEnv({ PIERCE_DATA: bucket });
  const bookingResponse = await handleRequest(jsonRequest("/booking/request", {
    guest_name: "Casey Robinson",
    guest_email: "casey@example.com",
    phone: "(619) 555-1212",
    topic: "Career planning",
    date,
    time: "2:00 PM",
    recording_consent: true,
    email_confirmed: true
  }), env);
  assert.equal(bookingResponse.status, 200);

  let acceptedSession;
  globalThis.fetch = async (url, init = {}) => {
    if (url === "https://api.openai.test/v1/realtime/calls/call-fast-check-in/accept") {
      acceptedSession = JSON.parse(init.body);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const storage = new MockDurableStorage();
  const socket = new MockPhoneSocket();
  const call = new PiercePhoneCall({ storage }, testEnv({
    OPENAI_API_KEY: "test-openai-key",
    PIERCE_DATA: bucket,
    PHONE_WEBSOCKET_CONNECT: async () => socket
  }));
  const response = await call.fetch(jsonRequest("/incoming", {
    call_id: "call-fast-check-in",
    webhook_id: "webhook-fast-check-in",
    caller_phone: "+1 619 555 1212"
  }));
  assert.equal(response.status, 200);
  assert.match(acceptedSession.instructions, /I have Casey associated with this phone number/);
  assert.match(acceptedSession.instructions, /walk-in career guide/);
  assert.doesNotMatch(acceptedSession.instructions, /What name is the booking under/);
  assert.doesNotMatch(acceptedSession.instructions, /casey@example\.com/);
  assert.deepEqual(acceptedSession.tools.map((tool) => tool.name), ["prepare_phone_check_in_summary"]);
  assert.equal(await storage.get("journey"), "walk_in");
});

test("phone walk-in asks only for a preferred first name when caller ID has no match", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let acceptedSession;
  globalThis.fetch = async (url, init = {}) => {
    if (url === "https://api.openai.test/v1/realtime/calls/call-walk-in-name/accept") {
      acceptedSession = JSON.parse(init.body);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const storage = new MockDurableStorage();
  const socket = new MockPhoneSocket();
  const call = new PiercePhoneCall({ storage }, testEnv({
    OPENAI_API_KEY: "test-openai-key",
    PIERCE_DATA: new MockR2Bucket(),
    PHONE_WEBSOCKET_CONNECT: async () => socket
  }));
  const response = await call.fetch(jsonRequest("/incoming", {
    call_id: "call-walk-in-name",
    webhook_id: "webhook-walk-in-name",
    caller_phone: "+1 858 555 0100"
  }));

  assert.equal(response.status, 200);
  assert.match(acceptedSession.instructions, /ask what first name the caller would like you to use/);
  assert.doesNotMatch(acceptedSession.instructions, /What name is the booking under/);
  assert.deepEqual(acceptedSession.tools.map((tool) => tool.name), ["prepare_phone_check_in_summary"]);
});

test("phone walk-in saves without an appointment or email when the caller declines a recap", async () => {
  const bucket = new MockR2Bucket();
  const storage = new MockDurableStorage();
  const socket = new MockPhoneSocket();
  const call = new PiercePhoneCall({ storage }, testEnv({ PIERCE_DATA: bucket }));
  call.socket = socket;
  call.state.callId = "call-walk-in-no-email";
  call.state.callerPhone = "+16195551212";
  const summary = {
    guest_name: "Jordan",
    job_interest: "Customer support",
    strength_or_experience: "Helping customers solve problems",
    immediate_challenge: "Explaining transferable experience",
    employer_question: "What does success look like in the first 90 days?",
    resource_key: "career_one_stop",
    next_step: "Review two customer support roles",
    next_step_target_date: "2026-11-02",
    recording_consent: true,
    participant_approved: true
  };

  await call.handleFunctionCall({
    call_id: "prepare-walk-in",
    response_id: "response-walk-in-summary",
    name: "prepare_phone_check_in_summary",
    arguments: JSON.stringify(summary)
  });
  assert.equal(await bucket.get("pierce-data/job-fair-quick-starts.jsonl"), null);
  assert.deepEqual(await storage.get("pending_phone_walk_in_summary"), summary);

  await call.handleSocketMessage(JSON.stringify({
    type: "response.created",
    response: { id: "response-walk-in-email-question" }
  }));
  await call.handleSocketMessage(JSON.stringify({
    type: "response.done",
    response: { id: "response-walk-in-email-question" }
  }));
  const consentMode = socket.sent.findLast((event) =>
    event.type === "session.update" && event.session.tools?.[0]?.name === "choose_phone_follow_up_email"
  );
  assert.equal(consentMode.session.tools.length, 1);

  await call.handleFunctionCall({
    call_id: "decline-walk-in-email",
    response_id: "response-walk-in-email-answer",
    name: "choose_phone_follow_up_email",
    arguments: JSON.stringify({ email_consent: false })
  });
  const storedObject = await bucket.get("pierce-data/job-fair-quick-starts.jsonl");
  const stored = JSON.parse((await storedObject.text()).trim());
  assert.equal(stored.event.slug, "pierce-phone-career-check-in");
  assert.equal(stored.participant.name, "Jordan");
  assert.equal(stored.participant.phone, "+16195551212");
  assert.equal(stored.participant.email, "");
  assert.equal(stored.email_consent, false);
  assert.equal(await storage.get("pending_phone_walk_in_summary"), undefined);
  assert.equal(call.state.awaitingFinalResponse, true);
});

test("phone walk-in requires separate one-time SMS consent after email permission", async () => {
  const bucket = new MockR2Bucket();
  const storage = new MockDurableStorage();
  const socket = new MockPhoneSocket();
  const call = new PiercePhoneCall({ storage }, testEnv({ PIERCE_DATA: bucket }));
  call.socket = socket;
  call.state.callId = "call-walk-in-sms-consent";
  call.state.callerPhone = "+16195551212";
  const summary = {
    guest_name: "Taylor",
    job_interest: "Project coordination",
    strength_or_experience: "Organization and communication",
    immediate_challenge: "Choosing useful training",
    employer_question: "Which skill matters most in the first month?",
    resource_key: "my_next_move",
    next_step: "Compare two project coordinator roles",
    next_step_target_date: "2026-11-03",
    recording_consent: true,
    participant_approved: true
  };
  call.state.pendingPhoneWalkInSummary = summary;
  await storage.put("pending_phone_walk_in_summary", summary);

  await call.handleFunctionCall({
    call_id: "request-walk-in-email",
    response_id: "response-request-walk-in-email",
    name: "choose_phone_follow_up_email",
    arguments: JSON.stringify({ email_consent: true })
  });
  assert.equal(await bucket.get("pierce-data/job-fair-quick-starts.jsonl"), null);
  const consentQuestion = socket.sent.findLast((event) => event.type === "session.update");
  assert.deepEqual(consentQuestion.session.tools, []);
  assert.equal(consentQuestion.session.tool_choice, "none");
  assert.match(consentQuestion.session.instructions, /one secure link/);
  assert.match(consentQuestion.session.instructions, /not marketing or recurring messages/);
  assert.match(consentQuestion.session.instructions, /Please say yes or no/);

  await call.handleSocketMessage(JSON.stringify({
    type: "response.created",
    response: { id: "response-walk-in-sms-question" }
  }));
  await call.handleSocketMessage(JSON.stringify({
    type: "response.done",
    response: { id: "response-walk-in-sms-question" }
  }));
  const smsConsentMode = socket.sent.findLast((event) =>
    event.type === "session.update" &&
    event.session.tools?.[0]?.name === "send_phone_email_link"
  );
  assert.deepEqual(smsConsentMode.session.tools.map((tool) => tool.name),
    ["send_phone_email_link"]);
  assert.deepEqual(smsConsentMode.session.tools[0].parameters.required, ["sms_consent"]);

  await call.handleFunctionCall({
    call_id: "decline-walk-in-sms",
    response_id: "response-decline-walk-in-sms",
    name: "send_phone_email_link",
    arguments: JSON.stringify({ sms_consent: false })
  });
  const storedObject = await bucket.get("pierce-data/job-fair-quick-starts.jsonl");
  const stored = JSON.parse((await storedObject.text()).trim());
  assert.equal(stored.participant.email, "");
  assert.equal(stored.email_consent, false);
  assert.equal(stored.email_status, "not_requested");
  assert.equal(call.state.awaitingFinalResponse, true);
});

test("secure email link sends once, stores the typed email, and rejects reuse", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const bucket = new MockR2Bucket();
  const env = testEnv({
    PIERCE_DATA: bucket,
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "twilio-test-token",
    TWILIO_FROM_NUMBER: "+18669672844",
    TWILIO_API_BASE: "https://api.twilio.test",
    PIERCE_EMAIL_ENTRY_BASE_URL: "https://voice.pierce.test"
  });
  const emailLinkObjects = attachEmailLinkNamespace(env);
  let sentForm;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(url, "https://api.twilio.test/2010-04-01/Accounts/ACtest/Messages.json");
    sentForm = new URLSearchParams(init.body);
    return Response.json({ sid: "SMtest", status: "queued" });
  };

  const storage = new MockDurableStorage();
  const socket = new MockPhoneSocket();
  const call = new PiercePhoneCall({ storage }, env);
  call.socket = socket;
  call.state.callId = "call-secure-email-link";
  call.state.callerPhone = "+16195551212";
  const summary = {
    guest_name: "Taylor",
    job_interest: "Project coordination",
    strength_or_experience: "Organization and communication",
    immediate_challenge: "Choosing useful training",
    employer_question: "Which skill matters most in the first month?",
    resource_key: "my_next_move",
    next_step: "Compare two project coordinator roles",
    next_step_target_date: "2026-11-03",
    recording_consent: true,
    participant_approved: true
  };
  call.state.pendingPhoneWalkInSummary = summary;
  await storage.put("pending_phone_walk_in_summary", summary);

  await call.handleFunctionCall({
    call_id: "send-secure-email-link",
    response_id: "response-send-secure-email-link",
    name: "send_phone_email_link",
    arguments: JSON.stringify({ sms_consent: true })
  });

  assert.equal(sentForm.get("To"), "+16195551212");
  assert.equal(sentForm.get("From"), "+18669672844");
  assert.match(sentForm.get("Body"), /one-time service message/);
  assert.match(sentForm.get("Body"), /Reply HELP for help or STOP to opt out/);
  const link = sentForm.get("Body").match(/https:\/\/voice\.pierce\.test\/email#[A-Za-z0-9_-]{43}/)?.[0];
  assert.ok(link);
  const token = link.split("#")[1];
  assert.equal(call.state.pendingPhoneWalkInSummary, null);
  assert.equal(call.state.awaitingFinalResponse, true);

  const statusResponse = await handleRequest(jsonRequest("/email-link/status", { token }), env);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).ok, true);

  const invalidEmail = await handleRequest(jsonRequest("/email-link/complete", {
    token,
    guest_email: "not-an-email",
    email_confirmed: true
  }), env);
  assert.equal(invalidEmail.status, 400);

  const completed = await handleRequest(jsonRequest("/email-link/complete", {
    token,
    guest_email: "taylor@example.com",
    email_confirmed: true
  }), env);
  const result = await completed.json();
  assert.equal(completed.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.email_status, "queued");

  const storedObject = await bucket.get("pierce-data/job-fair-quick-starts.jsonl");
  const stored = JSON.parse((await storedObject.text()).trim());
  assert.equal(stored.participant.email, "taylor@example.com");
  assert.equal(stored.participant.phone, "+16195551212");
  assert.equal(stored.email_consent, true);
  assert.match(stored.source_id, /^email-link:/);

  const reused = await handleRequest(jsonRequest("/email-link/complete", {
    token,
    guest_email: "other@example.com",
    email_confirmed: true
  }), env);
  assert.equal(reused.status, 404);

  const [{ storage: linkStorage }] = emailLinkObjects.values();
  const finalEntry = await linkStorage.get("email_link");
  assert.equal(finalEntry.status, "used");
  assert.equal("summary" in finalEntry, false);
});

test("secure email links reject expired tokens and remove their stored details", async () => {
  const storage = new MockDurableStorage();
  await storage.put("email_link", {
    status: "active",
    expires_at: new Date(Date.now() - 1000).toISOString(),
    summary: { guest_name: "Expired Test" },
    phone: "+16195550100"
  });
  const link = new PierceEmailLink({ storage }, testEnv());
  const response = await link.fetch(new Request("https://email-link.internal/status"));
  assert.equal(response.status, 404);
  assert.equal(await storage.get("email_link"), undefined);
});

test("email verification infers dot com for common providers without asking again", async () => {
  const env = testEnv();
  const examples = [
    ["alex at gmail", "alex@gmail.com"],
    ["alex at yahoo", "alex@yahoo.com"],
    ["alex at hotmail", "alex@hotmail.com"],
    ["alex at outlook", "alex@outlook.com"],
    ["alex at example dot com", "alex@example.com"]
  ];
  for (const [spoken, expected] of examples) {
    const response = await handleRequest(jsonRequest("/booking/email/verify", {
      guest_email: spoken
    }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).guest_email, expected);
  }

  const unfamiliar = await handleRequest(jsonRequest("/booking/email/verify", {
    guest_email: "alex at customprovider"
  }), env);
  assert.equal(unfamiliar.status, 400);
  assert.equal((await unfamiliar.json()).reason, "missing_domain_ending");
});

test("phone career sessions wait for explicit email consent before saving or ending", async () => {
  const bucket = new MockR2Bucket();
  const env = testEnv({ PIERCE_DATA: bucket });
  const date = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  const bookingResponse = await handleRequest(jsonRequest("/booking/request", {
    guest_name: "Career Consent Test",
    guest_email: "career-consent@example.com",
    topic: "Career planning",
    date,
    time: "1:00 PM",
    recording_consent: true,
    email_confirmed: true
  }), env);
  const booking = await bookingResponse.json();
  assert.equal(bookingResponse.status, 200);

  const storage = new MockDurableStorage();
  const socket = new MockPhoneSocket();
  const call = new PiercePhoneCall({ storage }, env);
  call.socket = socket;
  call.state.callId = "call-career-consent";

  await call.handleFunctionCall({
    call_id: "complete-too-soon",
    response_id: "response-too-soon",
    name: "complete_career_session",
    arguments: JSON.stringify({ email_consent: true })
  });
  const prematureOutput = socket.sent.find((event) =>
    event.type === "conversation.item.create" && event.item.call_id === "complete-too-soon"
  );
  assert.equal(JSON.parse(prematureOutput.item.output).reason, "career_summary_not_prepared");
  assert.equal(call.state.awaitingFinalResponse, false);
  assert.equal(await bucket.get("pierce-data/career-session-summaries.jsonl"), null);
  await call.handleSocketMessage(JSON.stringify({
    type: "response.done",
    response: { id: "response-too-soon" }
  }));

  const summary = {
    booking_request_id: booking.request_id,
    guest_city: "San Diego, California",
    useful_outcome: "Choose a practical next step",
    career_direction: "Project coordination",
    strengths_experience: "Organization and communication",
    primary_challenge: "Selecting the right training",
    mentor_connection_preference: "either",
    recommended_event: {
      name: "Local career networking event",
      format: "in_person",
      reason: "It offers direct conversations with people in the field."
    },
    next_step: "Review two project coordinator job descriptions",
    next_step_target_date: date,
    next_step_confirmed: true,
    resource_key: "career_one_stop",
    recording_consent: true
  };
  await call.handleFunctionCall({
    call_id: "prepare-summary",
    response_id: "response-summary",
    name: "prepare_career_summary",
    arguments: JSON.stringify(summary)
  });

  assert.equal(await bucket.get("pierce-data/career-session-summaries.jsonl"), null);
  assert.deepEqual(await storage.get("pending_career_summary"), summary);
  const consentMode = socket.sent.find((event) =>
    event.type === "session.update" && event.session.tool_choice === "none"
  );
  assert.deepEqual(consentMode.session.tools, []);
  assert.match(consentMode.session.instructions, /May I email a short summary/);

  await call.handleSocketMessage(JSON.stringify({
    type: "response.created",
    response: { id: "response-email-question" }
  }));
  await call.handleSocketMessage(JSON.stringify({
    type: "response.done",
    response: { id: "response-email-question" }
  }));
  const consentToolMode = socket.sent.findLast((event) =>
    event.type === "session.update" && event.session.tools?.[0]?.name === "complete_career_session"
  );
  assert.equal(consentToolMode.session.tools.length, 1);
  assert.deepEqual(consentToolMode.session.tools[0].parameters.required, ["email_consent"]);
  assert.equal(await bucket.get("pierce-data/career-session-summaries.jsonl"), null);

  await call.handleFunctionCall({
    call_id: "save-consented-summary",
    response_id: "response-email-answer",
    name: "complete_career_session",
    arguments: JSON.stringify({ email_consent: true })
  });
  const storedObject = await bucket.get("pierce-data/career-session-summaries.jsonl");
  const storedSummary = JSON.parse((await storedObject.text()).trim());
  assert.equal(storedSummary.booking_request_id, booking.request_id);
  assert.equal(storedSummary.email_consent, true);
  assert.equal(await storage.get("pending_career_summary"), undefined);
  assert.equal(call.state.awaitingFinalResponse, true);
});

test("serves public files through the static asset binding", async () => {
  const response = await handleRequest(
    new Request("https://staging.example/styles.css"),
    testEnv()
  );

  assert.equal(await response.text(), "asset:/styles.css");
});

test("serves the secure email page with restrictive browser headers", async () => {
  const response = await handleRequest(
    new Request("https://staging.example/email"),
    testEnv()
  );
  assert.equal(await response.text(), "asset:/email.html");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("saves a Logan Heights Job Fair quick start without requiring email", async () => {
  const env = testEnv({ PIERCE_DATA: new MockR2Bucket() });
  const configResponse = await handleRequest(
    new Request("https://staging.example/event/config?slug=logan-heights-job-fair"), env
  );
  const config = await configResponse.json();
  assert.equal(config.event.name, "Logan Heights Job Fair");
  assert.equal(config.event.experience, "job_fair_quick_start");

  const response = await handleRequest(jsonRequest("/event/job-fair/complete", {
    event_slug: "logan-heights-job-fair",
    guest_name: "Jordan Attendee",
    job_interest: "Customer support",
    strength_or_experience: "Helping customers solve problems",
    immediate_challenge: "Explaining transferable experience",
    employer_question: "What does success look like in the first 90 days?",
    resource_key: "climb_hire_san_diego",
    next_step: "Ask three employers the prepared question",
    next_step_target_date: "2026-10-28",
    recording_consent: true,
    participant_approved: true,
    email_consent: false
  }), env);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.email_status, "not_requested");
  assert.equal(result.resource.name, "Climb Hire San Diego");
  assert.equal("participant" in result, false);
});

test("emails the Logan Heights on-screen takeaway once without storing the recipient", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const gmailMessages = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url === "https://oauth-takeaway.example/token") {
      return Response.json({ access_token: "takeaway-token", expires_in: 3600 });
    }
    if (url === "https://gmail-takeaway.example/users/me/messages/send") {
      gmailMessages.push(JSON.parse(init.body));
      return Response.json({ id: "logan-takeaway-message" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const bucket = new MockR2Bucket();
  const env = testEnv({
    PIERCE_DATA: bucket,
    GOOGLE_CLIENT_ID: "takeaway-client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh",
    GOOGLE_OAUTH_TOKEN_URL: "https://oauth-takeaway.example/token",
    GOOGLE_GMAIL_API_BASE: "https://gmail-takeaway.example"
  });
  const response = await handleRequest(jsonRequest("/event/job-fair/complete", {
    event_slug: "logan-heights-job-fair",
    guest_name: "Jordan Attendee",
    guest_email: "",
    email_confirmed: false,
    job_interest: "Customer support",
    strength_or_experience: "Helping customers solve problems",
    immediate_challenge: "Explaining transferable experience",
    employer_question: "What does success look like in the first 90 days?",
    resource_key: "career_one_stop",
    next_step: "Ask three employers the prepared question",
    next_step_target_date: "2026-11-02",
    recording_consent: true,
    participant_approved: true,
    email_consent: false,
    delivery_mode: "guest_takeaway"
  }), env);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.email_status, "not_requested");
  assert.equal(result.email_available, true);
  assert.equal(result.takeaway.title, "Ready to speak with employers");
  assert.ok(result.takeaway.items.some((item) => item.label === "Question to ask employers"));

  const emailPayload = {
    delivery_id: result.delivery_id,
    guest_email: "jordan@example.com",
    email_consent: true,
    company: ""
  };
  const emailResponse = await handleRequest(jsonRequest("/guest-takeaway/email", emailPayload), env);
  assert.equal(emailResponse.status, 200);
  assert.equal(gmailMessages.length, 1);

  const rawEmail = Buffer.from(gmailMessages[0].raw, "base64url").toString("utf8");
  assert.match(rawEmail, /What does success look like in the first 90 days\?/);
  assert.match(rawEmail, /CareerOneStop/);
  assert.match(rawEmail, /Logan Heights CDC/);

  const stored = await bucket.get(
    `pierce-data/guest-takeaway-deliveries/${result.delivery_id}.json`
  );
  const delivery = JSON.parse(await stored.text());
  assert.equal(delivery.status, "sent");
  assert.equal("guest_email" in delivery, false);
  assert.doesNotMatch(JSON.stringify(delivery), /jordan@example\.com/i);

  const duplicateResponse = await handleRequest(
    jsonRequest("/guest-takeaway/email", emailPayload),
    env
  );
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicate.duplicate, true);
  assert.equal(gmailMessages.length, 1);
});

test("emails all Logan Heights partner resources when an attendee opts in", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let rawMessage = "";
  globalThis.fetch = async (url, init = {}) => {
    if (url === "https://oauth-job-fair.example/token") {
      return Response.json({ access_token: "job-fair-token", expires_in: 3600 });
    }
    if (url === "https://gmail-job-fair.example/users/me/messages/send") {
      rawMessage = JSON.parse(init.body).raw;
      return Response.json({ id: "job-fair-follow-up" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const env = testEnv({
    PIERCE_DATA: new MockR2Bucket(),
    GOOGLE_CLIENT_ID: "job-fair-client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh",
    GOOGLE_OAUTH_TOKEN_URL: "https://oauth-job-fair.example/token",
    GOOGLE_GMAIL_API_BASE: "https://gmail-job-fair.example"
  });
  const response = await handleRequest(jsonRequest("/event/job-fair/complete", {
    event_slug: "logan-heights-job-fair",
    guest_name: "Jordan Attendee",
    guest_email: "jordan@example.com",
    email_confirmed: true,
    job_interest: "Customer support",
    strength_or_experience: "Helping customers solve problems",
    immediate_challenge: "Explaining transferable experience",
    employer_question: "What does success look like in the first 90 days?",
    resource_key: "career_one_stop",
    next_step: "Ask three employers the prepared question",
    next_step_target_date: "2026-10-28",
    recording_consent: true,
    participant_approved: true,
    email_consent: true
  }), env);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.email_status, "sent");
  const message = Buffer.from(rawMessage, "base64url").toString("utf8");
  assert.match(message, /Climb Hire San Diego/);
  assert.match(message, /SBCS/);
  assert.match(message, /SDSU Careers/);
  assert.match(message, /International Rescue Committee San Diego/);
  assert.match(message, /Logan Heights CDC/);
  assert.match(message, /https:\/\/www\.loganheightscdc\.org\//);
  assert.match(message, /San Diego Workforce Partnership/);
  assert.match(message, /https:\/\/workforce\.org\//);
  assert.match(message, /UC San Diego Extended Studies & Google Career Certificates/);
  assert.match(message, /https:\/\/www\.workforce\.org\/about-google-meta\//);
  assert.match(message, /eligibility and availability vary/i);
});

test("serves the organizer interface only with an Access identity", async () => {
  const env = testEnv();
  const request = new Request("https://staging.example/events/city-highlights-careers/organizer");
  const denied = await handleRequest(request, env);
  assert.equal(denied.status, 403);

  const allowed = await handleRequest(request, env, accessContext());
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), "asset:/organizer.html");
  assert.equal(allowed.headers.get("cache-control"), "private, no-store");
  assert.equal(allowed.headers.get("x-frame-options"), "DENY");
});

test("serves short mentoring URLs while protecting organizer review", async () => {
  const env = testEnv();
  const participant = await handleRequest(new Request("https://staging.example/mentor"), env);
  assert.equal(participant.status, 200);
  assert.equal(await participant.text(), "asset:/index.html");

  const deniedAlias = await handleRequest(new Request("https://staging.example/mentor-review"), env);
  assert.equal(deniedAlias.status, 403);
  assert.equal(deniedAlias.headers.get("cache-control"), "no-store");

  const reviewAlias = await handleRequest(
    new Request("https://staging.example/mentor-review"), env, accessContext()
  );
  assert.equal(reviewAlias.status, 302);
  assert.equal(
    reviewAlias.headers.get("location"),
    "https://staging.example/events/san-diego-startup-week-mentoring/organizer"
  );

  const board = await handleRequest(new Request("https://staging.example/mentor-board"), env);
  assert.equal(board.status, 200);
  assert.equal(await board.text(), "asset:/mentor-board.html");
});

test("fails closed on every organizer review and data-management route", async () => {
  const env = testEnv();
  const protectedRequests = [
    new Request("https://staging.example/organizer"),
    new Request("https://staging.example/organizer.html"),
    new Request("https://staging.example/events/city-highlights-careers/organizer"),
    new Request("https://staging.example/event/review?slug=city-highlights-careers"),
    new Request("https://staging.example/event/review/bookings?slug=san-diego-startup-week-mentoring"),
    new Request("https://staging.example/event/review/mentors", { method: "POST" }),
    new Request("https://staging.example/event/review/approve", { method: "POST" }),
    new Request("https://staging.example/organizer/data/inventory"),
    new Request("https://staging.example/organizer/data/export"),
    new Request("https://staging.example/organizer/data/delete", { method: "POST" }),
    new Request("https://staging.example/organizer/data/hubspot-backfill-preview"),
    new Request("https://staging.example/organizer/data/hubspot-backfill", { method: "POST" })
  ];

  for (const request of protectedRequests) {
    const response = await handleRequest(request, env);
    assert.equal(response.status, 403, `${request.method} ${new URL(request.url).pathname}`);
    assert.deepEqual(await response.json(), { ok: false, reason: "organizer_access_required" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("exports event data and permanently deletes one participant with an audit record", async () => {
  const env = testEnv({ PIERCE_DATA: new MockR2Bucket() });
  const slug = "logan-heights-job-fair";
  const quickStart = (name, email) => jsonRequest("/event/job-fair/complete", {
    event_slug: slug,
    guest_name: name,
    guest_email: email,
    email_confirmed: true,
    job_interest: "Customer support",
    strength_or_experience: "Helping customers",
    immediate_challenge: "Finding an entry-level role",
    employer_question: "What does success look like in this role?",
    resource_key: "career_one_stop",
    next_step: "Contact one employer",
    next_step_target_date: "2026-11-01",
    recording_consent: true,
    participant_approved: true,
    email_consent: true
  });
  assert.equal((await handleRequest(quickStart("Jordan Attendee", "jordan@example.com"), env)).status, 200);
  assert.equal((await handleRequest(quickStart("Riley Attendee", "riley@example.com"), env)).status, 200);

  const inventoryUrl = `https://staging.example/organizer/data/inventory?slug=${slug}`;
  const denied = await handleRequest(new Request(inventoryUrl), env);
  assert.equal(denied.status, 403);
  const inventory = await handleRequest(new Request(inventoryUrl), env, accessContext());
  assert.equal(inventory.status, 200);
  assert.equal((await inventory.json()).total_records, 2);

  const exportResponse = await handleRequest(new Request(
    `https://staging.example/organizer/data/export?slug=${slug}`
  ), env, accessContext());
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-disposition"), /attachment/);
  const exported = await exportResponse.json();
  assert.equal(exported.total_records, 2);
  assert.equal(exported.datasets.job_fair_quick_starts.length, 2);

  const deletion = await handleRequest(jsonRequest("/organizer/data/delete", {
    event_slug: slug,
    participant_email: "jordan@example.com",
    confirmation: "DELETE"
  }), env, accessContext());
  const deleted = await deletion.json();
  assert.equal(deletion.status, 200);
  assert.equal(deleted.total_removed, 1);
  assert.match(deleted.audit_id, /^DMA-/);

  const remainingResponse = await handleRequest(new Request(inventoryUrl), env, accessContext());
  const remaining = await remainingResponse.json();
  assert.equal(remaining.total_records, 1);
  const remainingExport = await handleRequest(new Request(
    `https://staging.example/organizer/data/export?slug=${slug}`
  ), env, accessContext());
  const remainingData = await remainingExport.json();
  assert.equal(remainingData.datasets.job_fair_quick_starts[0].participant.email, "riley@example.com");
  assert.doesNotMatch(JSON.stringify(remainingData), /jordan@example\.com/);
});

test("previews a historical HubSpot backfill without queueing or writing data", async () => {
  const bucket = new MockR2Bucket();
  const queue = new MockQueue();
  const env = testEnv({ PIERCE_DATA: bucket, HUBSPOT_SYNC_QUEUE: queue, HUBSPOT_SERVICE_KEY: "test-key" });
  const intake = (email, name) => jsonRequest("/event/intake/participant", {
    event_slug: "san-diego-startup-week-mentoring",
    guest_name: name,
    guest_email: email,
    email_confirmed: true,
    recording_consent: true,
    information_sharing_consent: false,
    guest_city: "San Diego",
    career_stage: "Exploring",
    career_goal: "Find a mentor",
    primary_challenge: "Choosing a direction",
    mentor_questions: ["Where should I begin?", "What should I practice?"]
  });
  assert.equal((await handleRequest(intake("preview@example.com", "Preview Person"), env)).status, 200);
  assert.equal(queue.messages.length, 1);
  const response = await handleRequest(new Request(
    "https://staging.example/organizer/data/hubspot-backfill-preview"
  ), env, accessContext());
  const preview = await response.json();
  assert.equal(response.status, 200);
  assert.equal(preview.preview_only, true);
  assert.equal(preview.summary.unique_contacts, 1);
  assert.equal(preview.summary.records_ready, 0);
  assert.equal(preview.summary.records_already_synced, 1);
  assert.equal(preview.contacts[0].email, "preview@example.com");
  assert.equal(preview.contacts[0].proposed_action, "no_action_already_synced");
  assert.equal(queue.messages.length, 1);
});

test("queues only explicitly selected historical contacts for HubSpot backfill", async () => {
  const bucket = new MockR2Bucket();
  const queue = new MockQueue();
  const env = testEnv({ PIERCE_DATA: bucket, HUBSPOT_SYNC_QUEUE: queue, HUBSPOT_SERVICE_KEY: "test-key" });
  const quickStart = (email, name) => jsonRequest("/event/job-fair/complete", {
    event_slug: "logan-heights-job-fair",
    guest_name: name,
    guest_email: email,
    email_confirmed: true,
    job_interest: "Customer support",
    strength_or_experience: "Helping customers",
    immediate_challenge: "Finding a role",
    employer_question: "What does success look like?",
    resource_key: "career_one_stop",
    next_step: "Contact one employer",
    next_step_target_date: "2026-11-01",
    recording_consent: true,
    participant_approved: true,
    email_consent: true
  });
  await handleRequest(quickStart("ana@example.com", "Ana Example"), env);
  await handleRequest(quickStart("quentin@example.com", "Quentin Example"), env);
  await handleRequest(quickStart("excluded@example.com", "Excluded Example"), env);
  queue.messages = [];
  await bucket.put("pierce-data/hubspot-syncs.jsonl", "");
  const response = await handleRequest(jsonRequest("/organizer/data/hubspot-backfill", {
    emails: ["ana@example.com", "quentin@example.com"],
    confirmation: "BACKFILL"
  }), env, accessContext());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.records_queued, 2);
  assert.deepEqual(queue.messages.map((message) => message.body.record.participant.email).sort(),
    ["ana@example.com", "quentin@example.com"]);
});

test("reports R2 object existence without exposing persisted content", async () => {
  const env = testEnv({ PIERCE_DATA: new MockR2Bucket() });
  const response = await handleRequest(
    new Request("https://staging.example/__cloudflare/persistence"),
    env
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    binding: true,
    bucket: "pierce-voice-staging-data",
    objects: {
      bookings: { exists: false, size: 0 },
      check_ins: { exists: false, size: 0 },
      career_summaries: { exists: false, size: 0 },
      event_intakes: { exists: false, size: 0 },
      event_check_ins: { exists: false, size: 0 },
      event_summaries: { exists: false, size: 0 },
      mentor_bookings: { exists: false, size: 0 }
    }
  });
});

test("protects organizer review and idempotently approves a consented follow-up", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let rawMessage = "";
  globalThis.fetch = async (url, init = {}) => {
    if (url === "https://oauth-event.example/token") {
      return Response.json({ access_token: "event-token", expires_in: 3600 });
    }
    if (url === "https://gmail-event.example/users/me/messages/send") {
      rawMessage = JSON.parse(init.body).raw;
      return Response.json({ id: "event-follow-up-message" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const env = testEnv({
    PIERCE_DATA: new MockR2Bucket(),
    GOOGLE_CLIENT_ID: "event-review-client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh",
    GOOGLE_OAUTH_TOKEN_URL: "https://oauth-event.example/token",
    GOOGLE_GMAIL_API_BASE: "https://gmail-event.example"
  });
  const slug = "city-highlights-careers";
  const configResponse = await handleRequest(
    new Request(`https://staging.example/event/config?slug=${slug}`), env
  );
  assert.equal((await configResponse.json()).event.name, "City Highlights for Careers");

  const participantResponse = await handleRequest(jsonRequest("/event/intake/participant", {
    event_slug: slug,
    guest_name: "Mena Robinson",
    guest_email: "mena@example.com",
    email_confirmed: true,
    guest_city: "San Diego, California",
    career_stage: "Graduate student beginning a career",
    career_goal: "Find an entry point into workforce development",
    primary_challenge: "Choosing a practical first role",
    mentor_questions: ["Which roles should I explore first?", "What experience would help?"],
    recording_consent: true,
    information_sharing_consent: true,
    delivery_mode: "guest_takeaway"
  }), env);
  const participant = await participantResponse.json();
  assert.equal(participantResponse.status, 200);
  assert.equal(participant.hubspot_sync.reason, "hubspot_queue_not_configured");
  assert.equal(participant.email_available, true);
  assert.equal(participant.takeaway.title, "Prepared for City Highlights for Careers");

  const mentorResponse = await handleRequest(jsonRequest("/event/intake/mentor", {
    event_slug: slug,
    mentor_name: "Taylor Mentor",
    mentor_email: "taylor@example.com",
    email_confirmed: true,
    expertise: "Workforce development",
    support_offered: "Career pathway guidance",
    recording_consent: true,
    delivery_mode: "guest_takeaway"
  }), env);
  assert.equal(mentorResponse.status, 200);
  const mentor = await mentorResponse.json();
  assert.equal(mentor.email_available, true);
  assert.equal(mentor.takeaway.eyebrow, "YOUR MENTOR PREPARATION");

  const lookupResponse = await handleRequest(jsonRequest("/event/participant/lookup", {
    event_slug: slug, guest_name: "Mena Robinson"
  }), env);
  const lookup = await lookupResponse.json();
  assert.equal(lookup.match_count, 1);
  assert.equal("email" in lookup.matches[0], false);

  const checkInResponse = await handleRequest(jsonRequest("/event/check-in", {
    event_slug: slug, intake_id: participant.intake_id, recording_consent: true,
    delivery_mode: "guest_takeaway"
  }), env);
  assert.equal(checkInResponse.status, 200);
  const checkIn = await checkInResponse.json();
  assert.equal(checkIn.email_available, true);
  assert.equal(checkIn.takeaway.eyebrow, "CHECK-IN COMPLETE");

  const summaryResponse = await handleRequest(jsonRequest("/event/summary", {
    event_slug: slug,
    intake_id: participant.intake_id,
    key_guidance: ["Explore workforce program coordinator roles."],
    mentor_connection: "One introduction to a workforce leader.",
    recommended_event: "A local workforce networking event.",
    recommended_resource: "CareerOneStop.",
    next_step: "Update the resume",
    next_step_owner: "Mena",
    next_step_target_date: "2026-11-15",
    participant_approved: true,
    recording_consent: true,
    email_consent: true
  }), env);
  const summary = await summaryResponse.json();
  assert.equal(summary.status, "pending_organizer_review");
  assert.equal(summary.takeaway.eyebrow, "YOUR SESSION RECAP");

  const reviewResponse = await handleRequest(
    new Request(`https://staging.example/event/review?slug=${slug}`), env
  );
  assert.equal(reviewResponse.status, 403);

  const authorizedReviewResponse = await handleRequest(
    new Request(`https://staging.example/event/review?slug=${slug}`), env, accessContext()
  );
  const review = await authorizedReviewResponse.json();
  assert.equal(authorizedReviewResponse.status, 200);
  assert.equal(review.summaries.length, 1);
  assert.equal(review.summaries[0].review, null);

  const approvalRequest = () => jsonRequest("/event/review/approve", {
    summary_id: summary.summary_id,
    approved: true
  });
  const approvalResponse = await handleRequest(approvalRequest(), env, accessContext());
  const approval = await approvalResponse.json();
  assert.equal(approvalResponse.status, 200);
  assert.equal(approval.approved_by, "organizer@pierce.fund");
  assert.equal(approval.email_sent, true);
  assert.equal(approval.hubspot_sync.reason, "hubspot_queue_not_configured");
  const message = Buffer.from(rawMessage, "base64url").toString("utf8");
  assert.match(message, /To: mena@example\.com/);
  assert.match(message, /Update the resume/);

  const duplicateResponse = await handleRequest(approvalRequest(), env, accessContext());
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.email_sent, true);
});

test("books, protects, reschedules, and cancels Startup Week mentor appointments", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calendarEvents = [];
  const cancelledEvents = [];
  const participantEmails = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url === "https://oauth-mentoring.example/token") {
      return Response.json({ access_token: "mentoring-token", expires_in: 3600 });
    }
    if (String(url).includes("/calendars/primary/events?") && init.method === "POST") {
      const event = JSON.parse(init.body);
      calendarEvents.push(event);
      return Response.json({ id: event.id, htmlLink: `https://calendar.example/${event.id}` });
    }
    if (String(url).includes("/calendars/primary/events/") && init.method === "DELETE") {
      cancelledEvents.push(String(url));
      return new Response(null, { status: 204 });
    }
    if (String(url).includes("/gmail/v1/users/me/messages/send") && init.method === "POST") {
      participantEmails.push(Buffer.from(JSON.parse(init.body).raw, "base64url").toString("utf8"));
      return Response.json({ id: `participant-email-${participantEmails.length}` });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const env = testEnv({
    PIERCE_DATA: new MockR2Bucket(),
    PIERCE_MENTOR_NOTIFICATION_EMAIL: "voice@pierce.fund",
    GOOGLE_CLIENT_ID: "mentor-booking-client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh",
    GOOGLE_OAUTH_TOKEN_URL: "https://oauth-mentoring.example/token",
    GOOGLE_CALENDAR_API_BASE: "https://calendar-mentoring.example"
  });
  const slug = "san-diego-startup-week-mentoring";
  const availabilityResponse = await handleRequest(
    new Request(`https://staging.example/event/mentoring/availability?slug=${slug}`), env
  );
  const availability = await availabilityResponse.json();
  assert.equal(availability.slots.length, 36);
  assert.equal(availability.slots.every((slot) => slot.available), true);
  assert.equal(availability.schedule.start_times.at(-1), "14:00");
  assert.equal(availability.schedule.session_minutes, 30);
  assert.equal(availability.schedule.founder_capacity, 3);
  assert.equal(availability.slots.every((slot) => slot.seats_remaining === 3), true);
  assert.equal(availability.schedule.mentors[0].name, "Eric Bolt");
  assert.equal(availability.schedule.mentors[11].name, "Shawn Lynam");

  const bookingPayload = {
    event_slug: slug,
    participant_name: "Jordan Participant",
    participant_email: "jordan@example.com",
    biggest_challenge: "Finding repeatable customer acquisition.",
    email_confirmed: true,
    mentor_id: "mentor-1",
    start_time: "13:00"
  };
  const founderPayloads = [
    bookingPayload,
    { ...bookingPayload, participant_name: "Riley Participant", participant_email: "riley@example.com" },
    { ...bookingPayload, participant_name: "Morgan Participant", participant_email: "morgan@example.com" }
  ];
  const founderResponses = [];
  for (const payload of founderPayloads) {
    founderResponses.push(await handleRequest(jsonRequest("/event/mentoring/book", payload), env));
  }
  assert.equal(founderResponses.every((response) => response.status === 200), true);
  const conflict = await handleRequest(jsonRequest("/event/mentoring/book", {
    ...bookingPayload,
    participant_name: "Casey Participant",
    participant_email: "casey@example.com"
  }), env);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).reason, "slot_unavailable");
  const bookedFounders = [];
  for (const response of founderResponses) bookedFounders.push(await response.json());
  const booked = bookedFounders[0];
  assert.equal(booked.booking.location, "Table 1");
  assert.equal(calendarEvents.length, 3);
  const winnerEmail = booked.booking.booking_id === bookedFounders[0].booking.booking_id
    ? "jordan@example.com" : "";
  assert.equal(calendarEvents[0].attendees.some((attendee) => attendee.email === "voice@pierce.fund"), true);
  assert.equal(calendarEvents[0].location, "Pure Project Carlsbad · Table 1");
  assert.match(calendarEvents[0].start.dateTime, /2026-11-02T13:00:00-08:00/);
  assert.match(calendarEvents[0].end.dateTime, /2026-11-02T13:30:00-08:00/);
  assert.match(calendarEvents[0].description, /Finding repeatable customer acquisition\./);
  assert.match(
    calendarEvents[0].description,
    /events\/san-diego-startup-week-guide/
  );
  assert.equal(participantEmails.length, 3);
  assert.match(participantEmails[0], /To: jordan@example\.com/);
  assert.match(participantEmails[0], /events\/san-diego-startup-week-guide/);
  assert.ok(participantEmails[0].trim().endsWith(
    "https://pierce-voice-cloudflare-staging.piercefund.workers.dev/events/san-diego-startup-week-guide"
  ));

  const checkInResponse = await handleRequest(jsonRequest("/event/mentoring/check-in", {
    event_slug: slug,
    participant_email: "jordan@example.com"
  }), env);
  const checkedIn = await checkInResponse.json();
  assert.equal(checkInResponse.status, 200);
  assert.equal(Boolean(checkedIn.booking.checked_in_at), true);

  const denied = await handleRequest(
    new Request(`https://staging.example/event/review/bookings?slug=${slug}`), env
  );
  assert.equal(denied.status, 403);
  const organizerResponse = await handleRequest(
    new Request(`https://staging.example/event/review/bookings?slug=${slug}`), env, accessContext()
  );
  const organizer = await organizerResponse.json();
  assert.equal(organizer.bookings.filter((booking) => booking.status === "confirmed").length, 3);
  assert.equal(organizer.bookings[0].biggest_challenge, "Finding repeatable customer acquisition.");
  assert.equal(Boolean(organizer.bookings.find((booking) => booking.booking_id === booked.booking.booking_id).checked_in_at), true);

  const boardResponse = await handleRequest(
    new Request(`https://staging.example/event/mentoring/board?slug=${slug}`), env
  );
  const board = await boardResponse.json();
  assert.equal(boardResponse.status, 200);
  assert.equal(board.appointments.length, 3);
  assert.equal(board.appointments[0].participant_name, "Jordan P.");
  assert.equal(board.appointments[0].checked_in, true);
  assert.equal("biggest_challenge" in board.appointments[0], false);
  assert.equal("participant" in board.appointments[0], false);
  assert.equal("booking_id" in board.appointments[0], false);
  assert.equal(JSON.stringify(board).includes("jordan@example.com"), false);

  const rosterResponse = await handleRequest(jsonRequest("/event/review/mentors", {
    mentors: [
      { name: "Paola Ometto", expertise: ["Leadership", "Startups"], table: 1 },
      { name: "Added Mentor", expertise: ["Fundraising"], table: 1 },
      { name: "Eric Bolt", expertise: ["Legal", "Corporate Governance"], table: 2 },
      { name: "Another Mentor", expertise: ["Operations"], table: 13 }
    ]
  }), env, accessContext());
  assert.equal(rosterResponse.status, 200);
  const rosterResult = await rosterResponse.json();
  assert.deepEqual(rosterResult.roster.map((mentor) => mentor.table), [1, 1, 2, 13]);
  assert.deepEqual(rosterResult.schedule.mentors.map((mentor) => mentor.table), [1, 2, 13]);
  assert.equal(rosterResult.schedule.mentors[0].name, "Paola Ometto and Added Mentor");
  assert.deepEqual(rosterResult.schedule.mentors[0].expertise, ["Leadership", "Startups", "Fundraising"]);

  for (const extra of bookedFounders.slice(1)) {
    const response = await handleRequest(jsonRequest("/event/mentoring/cancel", {
      event_slug: slug,
      booking_id: extra.booking.booking_id,
      participant_email: extra.booking.booking_id === bookedFounders[1].booking.booking_id
        ? "riley@example.com" : "morgan@example.com"
    }), env);
    assert.equal(response.status, 200);
  }

  const rescheduleResponse = await handleRequest(jsonRequest("/event/mentoring/reschedule", {
    event_slug: slug,
    participant_email: winnerEmail,
    mentor_id: "mentor-2",
    start_time: "13:30"
  }), env);
  const rescheduled = await rescheduleResponse.json();
  assert.equal(rescheduleResponse.status, 200);
  assert.equal(rescheduled.booking.location, "Table 2");
  assert.equal(calendarEvents.length, 4);
  assert.match(calendarEvents[3].description, /Finding repeatable customer acquisition\./);
  assert.match(calendarEvents[3].description, /events\/san-diego-startup-week-guide/);
  assert.equal(participantEmails.length, 4);
  assert.match(participantEmails[3], /events\/san-diego-startup-week-guide/);
  assert.equal(cancelledEvents.length, 3);

  const cancelResponse = await handleRequest(jsonRequest("/event/mentoring/cancel", {
    event_slug: slug,
    participant_email: winnerEmail
  }), env);
  assert.equal(cancelResponse.status, 200);
  assert.equal((await cancelResponse.json()).booking.status, "cancelled");
  assert.equal(cancelledEvents.length, 4);

  const refreshed = await handleRequest(
    new Request(`https://staging.example/event/mentoring/availability?slug=${slug}`), env
  );
  const refreshedSlots = (await refreshed.json()).slots;
  assert.equal(refreshedSlots.find((slot) => slot.mentor_id === "mentor-1" && slot.start_time === "13:00").available, true);
  assert.equal(refreshedSlots.find((slot) => slot.mentor_id === "mentor-1" && slot.start_time === "13:00").seats_remaining, 3);
  assert.equal(refreshedSlots.find((slot) => slot.mentor_id === "mentor-2" && slot.start_time === "13:30").available, true);
});

test("queues a booking for HubSpot and idempotently creates one contact note", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const queue = new MockQueue();
  const env = testEnv({
    PIERCE_DATA: new MockR2Bucket(),
    HUBSPOT_SYNC_QUEUE: queue,
    HUBSPOT_SERVICE_KEY: "hubspot-secret",
    HUBSPOT_API_BASE: "https://hubspot.example"
  });
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const bookingResponse = await handleRequest(jsonRequest("/booking/request", {
    guest_name: "Jordan Participant",
    guest_email: "jordan@example.com",
    topic: "IT career planning",
    date,
    time: "1:00 PM",
    recording_consent: true,
    email_confirmed: true
  }), env);
  const booking = await bookingResponse.json();
  assert.equal(bookingResponse.status, 200);
  assert.equal(booking.hubspot_sync.status, "queued");
  assert.equal(queue.messages.length, 1);
  assert.equal(queue.messages[0].options.contentType, "json");

  let contactCreates = 0;
  let noteCreates = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/contacts/jordan%40example.com?idProperty=email")) {
      return Response.json({ message: "not found" }, { status: 404 });
    }
    if (url === "https://hubspot.example/crm/objects/2026-03/contacts" && init.method === "POST") {
      contactCreates += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.properties.email, "jordan@example.com");
      return Response.json({ id: "contact-1", properties: body.properties });
    }
    if (url === "https://hubspot.example/crm/objects/2026-03/notes" && init.method === "POST") {
      noteCreates += 1;
      const body = JSON.parse(init.body);
      assert.match(body.properties.hs_note_body, /IT career planning/);
      assert.equal(body.associations[0].to.id, "contact-1");
      return Response.json({ id: "note-1" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const delivery = () => {
    const state = { acked: false, retried: false };
    return { body: queue.messages[0].body, ack() { state.acked = true; },
      retry() { state.retried = true; }, state };
  };
  const first = delivery();
  await processHubspotQueue({ messages: [first] }, env);
  assert.equal(first.state.acked, true);
  assert.equal(first.state.retried, false);
  assert.equal(contactCreates, 1);
  assert.equal(noteCreates, 1);

  const duplicate = delivery();
  await processHubspotQueue({ messages: [duplicate] }, env);
  assert.equal(duplicate.state.acked, true);
  assert.equal(contactCreates, 1);
  assert.equal(noteCreates, 1);
});

test("manual HubSpot booking sync is migrated and preserves idempotency", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bucket = new MockR2Bucket();
  const booking = {
    request_id: "REQ-MANUAL-1",
    created_at: "2026-11-14T20:00:00.000Z",
    queue_type: "booking",
    status: "booked_google_calendar",
    date: "2026-11-20",
    time: "13:00",
    duration_minutes: 15,
    guest: { name: "Manual Guest", email: "manual@example.com", topic: "Career transition" }
  };
  await bucket.put("pierce-data/booking-requests.jsonl", `${JSON.stringify(booking)}\n`);
  const env = testEnv({
    PIERCE_DATA: bucket,
    HUBSPOT_SERVICE_KEY: "hubspot-secret",
    HUBSPOT_API_BASE: "https://hubspot.example"
  });
  let contacts = 0;
  let notes = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/contacts/manual%40example.com?idProperty=email")) {
      return Response.json({ message: "not found" }, { status: 404 });
    }
    if (url === "https://hubspot.example/crm/objects/2026-03/contacts") {
      contacts += 1;
      return Response.json({ id: "contact-manual" });
    }
    if (url === "https://hubspot.example/crm/objects/2026-03/notes") {
      notes += 1;
      assert.match(JSON.parse(init.body).properties.hs_note_body, /Career transition/);
      return Response.json({ id: "note-manual" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const response = await handleRequest(
    new Request("https://staging.example/hubspot/sync/latest-booking", { method: "POST" }),
    env
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "synced");
  const duplicate = await handleRequest(
    new Request("https://staging.example/hubspot/sync/latest-booking", { method: "POST" }),
    env
  );
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(contacts, 1);
  assert.equal(notes, 1);
});

test("production assets do not receive the staging phone-mode rewrite", async () => {
  const response = await handleRequest(new Request("https://voice.pierce.fund/"), testEnv({
    PIERCE_ENV: "production",
    ASSETS: { fetch: async () => new Response("<p class=\"phone-option\">Phone mode</p>", {
      headers: { "content-type": "text/html; charset=utf-8" }
    }) }
  }));
  assert.equal(await response.text(), "<p class=\"phone-option\">Phone mode</p>");
});

test("completes the staging Google OAuth handshake with state validation", async (t) => {
  const env = testEnv({
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://staging.example/calendar/oauth/callback",
    GOOGLE_OAUTH_TOKEN_URL: "https://oauth.example/token"
  });
  const connectResponse = await handleRequest(
    new Request("https://staging.example/calendar/connect"), env
  );
  assert.equal(connectResponse.status, 302);
  const authorization = new URL(connectResponse.headers.get("location"));
  assert.equal(authorization.searchParams.get("client_id"), "google-client-id");
  assert.equal(authorization.searchParams.get("redirect_uri"), env.GOOGLE_OAUTH_REDIRECT_URI);
  assert.match(connectResponse.headers.get("set-cookie"), /HttpOnly/);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://oauth.example/token");
    assert.equal(String(init.body.get("client_secret")), "google-client-secret");
    return Response.json({ refresh_token: "test-refresh-token", access_token: "test-access-token" });
  };
  const cookie = connectResponse.headers.get("set-cookie").split(";")[0];
  const callback = new URL(env.GOOGLE_OAUTH_REDIRECT_URI);
  callback.searchParams.set("code", "authorization-code");
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  const callbackResponse = await handleRequest(new Request(callback, {
    headers: { cookie }
  }), env);
  assert.equal(callbackResponse.status, 200);
  assert.match(await callbackResponse.text(), /test-refresh-token/);

  const rejectedResponse = await handleRequest(new Request(callback), env);
  assert.equal(rejectedResponse.status, 400);
});

test("reports Google configuration without exposing secrets", async () => {
  const response = await handleRequest(
    new Request("https://staging.example/calendar/status"),
    testEnv({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    configured: false,
    client_configured: true,
    refresh_token_configured: false,
    account_email: "voice@pierce.fund"
  });
});

test("persists career summaries and returns prior-session memory without exposing email", async () => {
  const env = testEnv({ PIERCE_DATA: new MockR2Bucket() });
  const firstDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const secondDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const guest = { guest_name: "Jordan Lee", guest_email: "jordan@example.com" };

  const firstBookingResponse = await handleRequest(jsonRequest("/booking/request", {
    ...guest, topic: "Data analytics", date: firstDate, time: "10:00 AM",
    recording_consent: true, email_confirmed: true
  }), env);
  const firstBooking = await firstBookingResponse.json();

  const completionPayload = {
    booking_request_id: firstBooking.request_id,
    guest_city: "San Diego, California",
    useful_outcome: "Choose a practical path into analytics",
    career_direction: "Data analytics",
    strengths_experience: "Customer service and spreadsheets",
    primary_challenge: "Choosing the right training",
    mentor_connection_preference: "online",
    recommended_event: {
      name: "Data careers information session",
      format: "online",
      reason: "It can clarify common entry paths."
    },
    resource_key: "onet_online",
    next_step: "Compare two entry-level analyst job descriptions",
    next_step_target_date: secondDate,
    next_step_confirmed: true,
    recording_consent: true,
    email_consent: true,
    delivery_mode: "guest_takeaway"
  };
  const completionResponse = await handleRequest(
    jsonRequest("/career-session/complete", completionPayload), env
  );
  const completion = await completionResponse.json();
  assert.equal(completionResponse.status, 200);
  assert.match(completion.session_id, /^SES-/);
  assert.equal(completion.email_sent, false);
  assert.equal(completion.research_enhanced, false);
  assert.equal(completion.takeaway.eyebrow, "YOUR CAREER SESSION SUMMARY");

  const duplicateResponse = await handleRequest(
    jsonRequest("/career-session/complete", completionPayload), env
  );
  assert.equal((await duplicateResponse.json()).duplicate, true);

  await handleRequest(jsonRequest("/booking/cancel", {
    guest_email: guest.guest_email,
    booking_request_id: firstBooking.request_id,
    cancellation_confirmed: true
  }), env);
  const secondBookingResponse = await handleRequest(jsonRequest("/booking/request", {
    ...guest, topic: "Analytics follow-up", date: secondDate, time: "11:00 AM",
    recording_consent: true, email_confirmed: true
  }), env);
  const secondBooking = await secondBookingResponse.json();

  const lookupResponse = await handleRequest(
    jsonRequest("/career-session/lookup", { guest_name: guest.guest_name, date: secondDate }), env
  );
  const lookup = await lookupResponse.json();
  assert.equal(lookup.match_count, 1);
  assert.equal(lookup.matches[0].booking_request_id, secondBooking.request_id);
  assert.equal("guest_email" in lookup.matches[0], false);

  const deniedMemoryResponse = await handleRequest(jsonRequest("/career-session/memory", {
    booking_request_id: secondBooking.request_id,
    guest_email: "someone-else@example.com",
    email_confirmed: true
  }), env);
  assert.equal(deniedMemoryResponse.status, 403);

  const memoryResponse = await handleRequest(jsonRequest("/career-session/memory", {
    booking_request_id: secondBooking.request_id,
    guest_email: guest.guest_email,
    email_confirmed: true
  }), env);
  const memory = await memoryResponse.json();
  assert.equal(memory.returning_guest, true);
  assert.equal(memory.previous_session.next_step.action, completionPayload.next_step);
  assert.match(memory.previous_session.follow_up_question, /Last time, your next step/);
});

test("persists the booking and check-in lifecycle in isolated R2", async () => {
  const env = testEnv({ PIERCE_DATA: new MockR2Bucket() });
  const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const bookingPayload = {
    guest_name: "Casey Robinson",
    guest_email: "casey@example.com",
    topic: "Career planning",
    date,
    time: "2:00 PM",
    recording_consent: true,
    email_confirmed: true
  };

  const verifiedResponse = await handleRequest(
    jsonRequest("/booking/email/verify", { guest_email: "casey at example dot com" }),
    env
  );
  assert.equal(verifiedResponse.status, 200);
  assert.equal((await verifiedResponse.json()).guest_email, "casey@example.com");

  const bookingResponse = await handleRequest(jsonRequest("/booking/request", bookingPayload), env);
  const booking = await bookingResponse.json();
  assert.equal(bookingResponse.status, 200);
  assert.equal(booking.status, "cloudflare_staging_saved");
  assert.equal(booking.booked, false);
  assert.equal(booking.queued, true);

  const duplicateResponse = await handleRequest(jsonRequest("/booking/request", bookingPayload), env);
  assert.equal(duplicateResponse.status, 409);
  assert.equal((await duplicateResponse.json()).reason, "existing_booking");

  const existingResponse = await handleRequest(
    jsonRequest("/booking/existing", { guest_email: bookingPayload.guest_email, email_confirmed: true }),
    env
  );
  assert.equal((await existingResponse.json()).match_count, 1);

  const lookupResponse = await handleRequest(
    jsonRequest("/check-in/lookup", { guest_name: bookingPayload.guest_name, date }),
    env
  );
  const lookup = await lookupResponse.json();
  assert.equal(lookup.match_count, 1);
  assert.equal(lookup.matches[0].booking_request_id, booking.request_id);

  const checkInResponse = await handleRequest(
    jsonRequest("/check-in/request", {
      guest_name: bookingPayload.guest_name,
      date,
      session_time: "2:00 PM",
      booking_request_id: booking.request_id,
      topic: bookingPayload.topic,
      recording_consent: true
    }),
    env
  );
  assert.equal((await checkInResponse.json()).status, "cloudflare_staging_saved");

  const secondCheckInResponse = await handleRequest(
    jsonRequest("/check-in/request", {
      guest_name: bookingPayload.guest_name,
      date,
      session_time: "2:00 PM",
      booking_request_id: booking.request_id,
      topic: bookingPayload.topic,
      recording_consent: true
    }),
    env
  );
  assert.equal((await secondCheckInResponse.json()).status, "cloudflare_staging_saved");

  const cancellationResponse = await handleRequest(
    jsonRequest("/booking/cancel", {
      guest_email: bookingPayload.guest_email,
      booking_request_id: booking.request_id,
      cancellation_confirmed: true
    }),
    env
  );
  assert.equal(cancellationResponse.status, 200);

  const afterCancellationResponse = await handleRequest(
    jsonRequest("/booking/existing", { guest_email: bookingPayload.guest_email, email_confirmed: true }),
    env
  );
  assert.equal((await afterCancellationResponse.json()).match_count, 0);
});

test("supports quiet booking and check-in without recording consent", async () => {
  const bucket = new MockR2Bucket();
  const env = testEnv({ PIERCE_DATA: bucket });
  const date = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10);
  const bookingResponse = await handleRequest(jsonRequest("/booking/request", {
    guest_name: "Quiet Guest",
    guest_email: "quiet@example.com",
    topic: "Career planning without voice",
    date,
    time: "10:30",
    interaction_mode: "quiet",
    recording_consent: false,
    email_confirmed: true
  }), env);
  const booking = await bookingResponse.json();
  assert.equal(bookingResponse.status, 200);

  const lookupResponse = await handleRequest(jsonRequest("/check-in/lookup", {
    guest_name: "Quiet Guest",
    date
  }), env);
  const lookup = await lookupResponse.json();
  assert.equal(lookup.match_count, 1);

  const checkInResponse = await handleRequest(jsonRequest("/check-in/request", {
    guest_name: "Quiet Guest",
    date,
    session_time: "10:30",
    booking_request_id: booking.request_id,
    topic: "Career planning without voice",
    interaction_mode: "quiet",
    recording_consent: false
  }), env);
  assert.equal(checkInResponse.status, 200);

  const bookingText = await (await bucket.get("pierce-data/booking-requests.jsonl")).text();
  const checkInText = await (await bucket.get("pierce-data/check-in-requests.jsonl")).text();
  const bookings = bookingText.trim().split("\n").map((line) => JSON.parse(line));
  const checkIns = checkInText.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(bookings[0].interaction_mode, "quiet");
  assert.equal(bookings[0].recording_consent, false);
  assert.equal(checkIns[0].interaction_mode, "quiet");
  assert.equal(checkIns[0].recording_consent, false);
});

test("books and cancels a staging Google Calendar event", async (t) => {
  const requests = [];
  let rawConfirmation = "";
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (url === "https://oauth.example/token") {
      return Response.json({ access_token: "calendar-access-token", expires_in: 3600 });
    }
    if (url === "https://calendar.example/freeBusy") {
      return Response.json({ calendars: { primary: { busy: [] } } });
    }
    if (String(url).includes("/calendars/primary/events?")) {
      const event = JSON.parse(init.body);
      return Response.json({ id: event.id, htmlLink: "https://calendar.example/event" });
    }
    if (url === "https://gmail-calendar.example/users/me/messages/send") {
      rawConfirmation = JSON.parse(init.body).raw;
      return Response.json({ id: "booking-confirmation-message" });
    }
    if (String(url).includes("/calendars/primary/events/") && init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: { message: "unexpected request" } }, { status: 500 });
  };
  const env = testEnv({
    PIERCE_DATA: new MockR2Bucket(),
    GOOGLE_CLIENT_ID: "calendar-test-client",
    GOOGLE_CLIENT_SECRET: "calendar-test-secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "calendar-test-refresh",
    GOOGLE_OAUTH_TOKEN_URL: "https://oauth.example/token",
    GOOGLE_CALENDAR_API_BASE: "https://calendar.example",
    GOOGLE_GMAIL_API_BASE: "https://gmail-calendar.example"
  });
  const date = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  const payload = { guest_name: "Calendar Test", guest_email: "calendar@example.com",
    topic: "Cloudflare test", date, time: "9:00 AM", recording_consent: true, email_confirmed: true };
  const bookingResponse = await handleRequest(jsonRequest("/booking/request", payload), env);
  const booking = await bookingResponse.json();
  assert.equal(bookingResponse.status, 200);
  assert.equal(booking.booked, true);
  assert.equal(booking.invite_sent, true);
  assert.equal(booking.confirmation_email_sent, true);
  assert.equal(booking.status, "booked_google_calendar");
  assert.match(booking.confirmation, /^PIERCE-/);
  assert.equal(booking.event_url, "https://calendar.example/event");
  const confirmationMessage = Buffer.from(rawConfirmation, "base64url").toString("utf8");
  assert.match(confirmationMessage, /To: calendar@example\.com/);
  assert.match(confirmationMessage, /Your 15-minute session with Pierce is booked\./);

  const cancellationResponse = await handleRequest(jsonRequest("/booking/cancel", {
    guest_email: payload.guest_email,
    booking_request_id: booking.request_id,
    cancellation_confirmed: true
  }), env);
  assert.equal(cancellationResponse.status, 200);
  assert.ok(requests.some((request) => request.url.endsWith("?sendUpdates=all") && request.init.method === "DELETE"));
});

test("does not create a Google event when the requested time is busy", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    if (url === "https://oauth-busy.example/token") return Response.json({ access_token: "busy-token", expires_in: 3600 });
    if (url === "https://calendar-busy.example/freeBusy") return Response.json({ calendars: { primary: { busy: [{ start: "x", end: "y" }] } } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const env = testEnv({ PIERCE_DATA: new MockR2Bucket(), GOOGLE_CLIENT_ID: "busy-client",
    GOOGLE_CLIENT_SECRET: "secret", GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh",
    GOOGLE_OAUTH_TOKEN_URL: "https://oauth-busy.example/token", GOOGLE_CALENDAR_API_BASE: "https://calendar-busy.example" });
  const date = new Date(Date.now() + 50 * 86400000).toISOString().slice(0, 10);
  const response = await handleRequest(jsonRequest("/booking/request", { guest_name: "Busy Guest",
    guest_email: "busy@example.com", topic: "Busy test", date, time: "10:00 AM",
    recording_consent: true, email_confirmed: true }), env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "time_unavailable");
});

test("sends a consented career follow-up through Gmail and remembers delivery", async (t) => {
  const env = testEnv({ PIERCE_DATA: new MockR2Bucket() });
  const date = new Date(Date.now() + 55 * 86400000).toISOString().slice(0, 10);
  const bookingResponse = await handleRequest(jsonRequest("/booking/request", {
    guest_name: "Email Guest", guest_email: "email@example.com", topic: "Career planning",
    date, time: "1:00 PM", recording_consent: true, email_confirmed: true
  }), env);
  const booking = await bookingResponse.json();

  Object.assign(env, { GOOGLE_CLIENT_ID: "gmail-client", GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh", GOOGLE_OAUTH_TOKEN_URL: "https://oauth-gmail.example/token",
    GOOGLE_GMAIL_API_BASE: "https://gmail.example" });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let rawMessage = "";
  globalThis.fetch = async (url, init = {}) => {
    if (url === "https://oauth-gmail.example/token") return Response.json({ access_token: "gmail-token", expires_in: 3600 });
    if (url === "https://gmail.example/users/me/messages/send") {
      rawMessage = JSON.parse(init.body).raw;
      return Response.json({ id: "gmail-message-1" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const payload = {
    booking_request_id: booking.request_id, guest_city: "San Diego, California",
    useful_outcome: "Choose a career direction", career_direction: "Project management",
    strengths_experience: "Organization and communication", primary_challenge: "Selecting training",
    recommended_event: { name: "Project management workshop", format: "online", reason: "It introduces the field." },
    resource_key: "career_one_stop", next_step: "Review two project coordinator roles",
    next_step_target_date: date, next_step_confirmed: true, recording_consent: true, email_consent: true
  };
  const completionResponse = await handleRequest(jsonRequest("/career-session/complete", payload), env);
  const completion = await completionResponse.json();
  assert.equal(completion.email_sent, true);
  assert.equal(completion.email_queued, false);
  assert.ok(rawMessage);

  const duplicateResponse = await handleRequest(jsonRequest("/career-session/complete", payload), env);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.email_sent, true);
});

test("requires the staging OpenAI secret for realtime sessions", async () => {
  const response = await handleRequest(
    new Request("https://staging.example/session", {
      method: "POST",
      body: "v=0\r\n"
    }),
    testEnv()
  );

  assert.equal(response.status, 503);
  assert.match(await response.text(), /OPENAI_API_KEY/);
});

test("forwards an SDP offer to OpenAI without exposing the secret", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let received;
  globalThis.fetch = async (url, init) => {
    received = { url, init };
    return new Response("v=0\r\nanswer", {
      status: 200,
      headers: { "content-type": "application/sdp" }
    });
  };

  const response = await handleRequest(
    new Request("https://staging.example/session?mode=book", {
      method: "POST",
      body: "v=0\r\noffer"
    }),
    testEnv({ OPENAI_API_KEY: "test-secret" })
  );

  assert.equal(received.url, "https://api.openai.test/v1/realtime/calls");
  assert.equal(received.init.headers.Authorization, "Bearer test-secret");
  assert.equal(await received.init.body.get("sdp"), "v=0\r\noffer");
  assert.equal(JSON.parse(received.init.body.get("session")).model, "gpt-realtime-2.1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/sdp");
  assert.equal(await response.text(), "v=0\r\nanswer");
});
