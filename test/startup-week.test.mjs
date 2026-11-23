import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/cloudflare-worker.mjs";
import { recommendStartupWeekEvents } from "../src/cloudflare-startup-week.mjs";

class MockR2Bucket {
  #objects = new Map();
  #version = 0;

  async get(key) {
    const object = this.#objects.get(key);
    return object ? { etag: object.etag, text: async () => object.text } : null;
  }

  async put(key, value, options = {}) {
    const current = this.#objects.get(key);
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
    this.#version += 1;
    const stored = { text: String(value), etag: `etag-${this.#version}` };
    this.#objects.set(key, stored);
    return { etag: stored.etag };
  }

  async delete(key) {
    this.#objects.delete(key);
  }
}

function testEnv(overrides = {}) {
  return {
    PIERCE_ENV: "staging",
    ASSETS: {
      fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`);
      }
    },
    ...overrides
  };
}

function recommendationRequest(body) {
  return new Request("https://staging.example/startup-week/recommend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function emailRequest(body) {
  return new Request("https://staging.example/startup-week/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("exposes the dedicated Startup Week guide event", async () => {
  const response = await handleRequest(
    new Request("https://staging.example/event/config?slug=san-diego-startup-week-guide"),
    testEnv()
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.event.name, "San Diego Startup Week Guide");
  assert.equal(result.event.experience, "startup_week_guide");
  assert.equal(result.event.date_label, "November 2–6, 2026");
});

test("publishes the official schedule snapshot metadata", async () => {
  const response = await handleRequest(
    new Request("https://staging.example/startup-week/schedule"),
    testEnv()
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.schedule.event_count, 68);
  assert.equal(result.schedule.dates.length, 5);
  assert.equal(result.schedule.source_url, "https://sandiegostartupweek.org/");
});

test("curates grounded funding and biotech events from the official schedule", async () => {
  const response = await handleRequest(recommendationRequest({
    goal: "I want to meet investors and learn how to fund my biotech company",
    available_dates: [],
    limit: 4
  }), testEnv());
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.recommendations.length, 4);
  assert.equal(result.recommendations[0].title, "Seed2Table – Pitch+Dinner for Life Science Investors");
  assert.ok(result.recommendations.some((event) => /Biotech|Life Science/.test(event.title)));
  for (const event of result.recommendations) {
    assert.match(event.event_url, /^https:\/\/sandiegostartupweek\.org\/events\//);
    assert.doesNotMatch(event.title, /Check In/i);
  }
});

test("honors the guest's available Startup Week dates", () => {
  const result = recommendStartupWeekEvents({
    goal: "I want practical help with marketing, customers, and telling my story",
    available_dates: ["2026-11-03"],
    limit: 4
  });

  assert.equal(result.ok, true);
  assert.equal(result.recommendations.length, 4);
  assert.ok(result.recommendations.every((event) => event.date === "2026-11-03"));
  assert.ok(result.recommendations.some((event) => event.title === "Story-Selling Method"));
});

test("leads broad mentoring requests with the Carlsbad Speed Mentoring session", () => {
  const result = recommendStartupWeekEvents({
    goal: "I want mentoring and to meet experienced business people who can help me",
    available_dates: [],
    limit: 4
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.recommendations[0].title,
    "Speed Mentoring Powered by Fōkcus & San Diego & Imperial SBDC"
  );
  assert.equal(result.recommendations[0].venue, "Pure Project Carlsbad");
  assert.equal(result.recommendations[0].date, "2026-11-02");
  assert.match(result.recommendations[0].reason, /mentoring in Carlsbad/i);
});

test("does not recommend the Carlsbad mentoring session when Monday is unavailable", () => {
  const result = recommendStartupWeekEvents({
    goal: "I want mentoring and startup advice",
    available_dates: ["2026-11-06"],
    limit: 4
  });

  assert.equal(result.ok, true);
  assert.ok(result.recommendations.every((event) => event.date === "2026-11-06"));
  assert.ok(result.recommendations.every((event) => !event.title.startsWith("Speed Mentoring")));
});

test("supports a two-event narrowed shortlist", () => {
  const result = recommendStartupWeekEvents({
    goal: "Prioritize direct mentoring",
    available_dates: [],
    limit: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.recommendations.length, 2);
  assert.equal(
    result.recommendations[0].title,
    "Speed Mentoring Powered by Fōkcus & San Diego & Imperial SBDC"
  );
});

test("rejects dates outside the published Startup Week schedule", async () => {
  const response = await handleRequest(recommendationRequest({
    goal: "I want to meet founders",
    available_dates: ["2026-11-07"]
  }), testEnv());
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.reason, "invalid_startup_week_date");
});

test("emails the exact generated Startup Week shortlist only once", async (t) => {
  const originalFetch = globalThis.fetch;
  const gmailMessages = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://oauth-startup-week.example/token") {
      return Response.json({ access_token: "startup-week-token", expires_in: 3600 });
    }
    if (url === "https://gmail-startup-week.example/users/me/messages/send") {
      gmailMessages.push(JSON.parse(init.body));
      return Response.json({ id: "startup-week-message-1" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = testEnv({
    PIERCE_DATA: new MockR2Bucket(),
    GOOGLE_CLIENT_ID: "startup-week-email-test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "test-refresh-token",
    GOOGLE_OAUTH_TOKEN_URL: "https://oauth-startup-week.example/token",
    GOOGLE_GMAIL_API_BASE: "https://gmail-startup-week.example",
    GOOGLE_CALENDAR_ACCOUNT_EMAIL: "voice@pierce.fund"
  });
  const recommendationResponse = await handleRequest(recommendationRequest({
    goal: "I want mentoring and experienced startup advice",
    available_dates: [],
    limit: 3
  }), env);
  const recommendation = await recommendationResponse.json();

  assert.equal(recommendationResponse.status, 200);
  assert.equal(recommendation.email_available, true);
  assert.match(recommendation.delivery_id, /^[0-9a-f-]{36}$/i);

  const invalidResponse = await handleRequest(emailRequest({
    delivery_id: recommendation.delivery_id,
    guest_email: "not-an-email",
    email_consent: true,
    company: ""
  }), env);
  assert.equal(invalidResponse.status, 400);

  const deliveryPayload = {
    delivery_id: recommendation.delivery_id,
    guest_email: "guest@example.com",
    email_consent: true,
    company: ""
  };
  const emailResponse = await handleRequest(emailRequest(deliveryPayload), env);
  const emailResult = await emailResponse.json();

  assert.equal(emailResponse.status, 200);
  assert.equal(emailResult.email_status, "sent");
  assert.equal(gmailMessages.length, 1);

  const rawEmail = Buffer.from(gmailMessages[0].raw, "base64url").toString("utf8");
  for (const event of recommendation.recommendations) {
    assert.ok(rawEmail.includes(event.title));
    assert.ok(rawEmail.includes(event.event_url));
  }
  assert.match(rawEmail, /not a subscription or marketing message/i);

  const stored = await env.PIERCE_DATA.get(
    `pierce-data/guest-takeaway-deliveries/${recommendation.delivery_id}.json`
  );
  const storedDelivery = JSON.parse(await stored.text());
  assert.equal(storedDelivery.status, "sent");
  assert.equal("guest_email" in storedDelivery, false);
  assert.doesNotMatch(JSON.stringify(storedDelivery), /guest@example\.com/i);

  const duplicateResponse = await handleRequest(emailRequest(deliveryPayload), env);
  const duplicateResult = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateResult.duplicate, true);
  assert.equal(gmailMessages.length, 1);
});
