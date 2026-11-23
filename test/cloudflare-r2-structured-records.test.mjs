import assert from "node:assert/strict";
import test from "node:test";

import { handleCareerRoute } from "../src/cloudflare-career.mjs";

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

test("R2 career records keep structured outcomes and discard raw conversation data", async () => {
  const bucket = new MockR2Bucket();
  await bucket.put("pierce-data/booking-requests.jsonl", `${JSON.stringify({
    request_id: "REQ-STRUCTURED-1",
    queue_type: "booking",
    status: "confirmed",
    created_at: "2026-11-22T18:00:00.000Z",
    date: "2026-11-30",
    time: "10:00 AM",
    guest: { name: "Privacy Test", email: "privacy-test@example.com", topic: "Career direction" }
  })}\n`);

  const response = await handleCareerRoute(new Request("https://staging.example/career-session/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      booking_request_id: "REQ-STRUCTURED-1",
      guest_city: "San Diego, California",
      useful_outcome: "Choose a realistic next career direction",
      career_direction: "Data analytics",
      strengths_experience: "Customer service and spreadsheets",
      primary_challenge: "Choosing affordable training",
      recommended_event: {
        name: "Career exploration workshop",
        format: "online",
        reason: "It supports comparison of entry paths."
      },
      resource_key: "onet_online",
      mentor_connection_preference: "online",
      next_step: "Compare two entry-level analyst roles",
      next_step_target_date: "2026-12-05",
      next_step_confirmed: true,
      recording_consent: true,
      email_consent: false,
      transcript: "This full transcript must never be stored.",
      raw_audio: "base64-audio-must-never-be-stored",
      conversation_history: [{ role: "user", content: "private verbatim answer" }]
    })
  }), { PIERCE_DATA: bucket });

  assert.equal(response.status, 200);
  const stored = bucket.objects.get("pierce-data/career-session-summaries.jsonl")?.text || "";
  assert.match(stored, /Choose a realistic next career direction/);
  assert.match(stored, /Data analytics/);
  assert.match(stored, /Customer service and spreadsheets/);
  assert.match(stored, /Choosing affordable training/);
  assert.match(stored, /O\*NET OnLine/);
  assert.match(stored, /Compare two entry-level analyst roles/);
  assert.doesNotMatch(stored, /full transcript/i);
  assert.doesNotMatch(stored, /base64-audio/i);
  assert.doesNotMatch(stored, /private verbatim answer/i);
  assert.doesNotMatch(stored, /"transcript"|"raw_audio"|"conversation_history"/);
});
