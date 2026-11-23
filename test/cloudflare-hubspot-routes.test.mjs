import assert from "node:assert/strict";
import test from "node:test";

import { handleHubspotRoute } from "../src/cloudflare-hubspot.mjs";

class MockR2Bucket {
  objects = new Map();
  version = 0;

  async get(key) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, text: async () => object.text } : null;
  }

  async put(key, value, options = {}) {
    const current = this.objects.get(key);
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
    const object = { text: String(value), etag: `etag-${++this.version}` };
    this.objects.set(key, object);
    return object;
  }
}

test("manual booking sync is authenticated through the configured HubSpot service", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bucket = new MockR2Bucket();
  await bucket.put("pierce-data/booking-requests.jsonl", `${JSON.stringify({
    request_id: "REQ-1", queue_type: "booking", created_at: "2026-11-14T20:00:00.000Z",
    date: "2026-11-20", time: "13:00", duration_minutes: 15,
    guest: { name: "Manual Guest", email: "manual@example.com", topic: "Career transition" }
  })}\n`);
  let contacts = 0;
  let notes = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/contacts/manual%40example.com?idProperty=email")) {
      return Response.json({ message: "not found" }, { status: 404 });
    }
    if (url === "https://hubspot.example/crm/objects/2026-03/contacts") {
      contacts += 1;
      return Response.json({ id: "contact-1" });
    }
    if (url === "https://hubspot.example/crm/objects/2026-03/notes") {
      notes += 1;
      assert.match(JSON.parse(init.body).properties.hs_note_body, /Career transition/);
      return Response.json({ id: "note-1" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const env = { PIERCE_DATA: bucket, HUBSPOT_SERVICE_KEY: "secret",
    HUBSPOT_API_BASE: "https://hubspot.example" };
  const first = await handleHubspotRoute(new Request("https://example.com/hubspot/sync/latest-booking", {
    method: "POST"
  }), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, "synced");
  const second = await handleHubspotRoute(new Request("https://example.com/hubspot/sync/latest-booking", {
    method: "POST"
  }), env);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(contacts, 1);
  assert.equal(notes, 1);
});

test("manual sync routes fail closed when required bindings are unavailable", async () => {
  const response = await handleHubspotRoute(new Request(
    "https://example.com/hubspot/sync/latest-booking", { method: "POST" }
  ), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, "r2_not_configured");
});
