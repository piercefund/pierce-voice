import assert from "node:assert/strict";
import test from "node:test";

import { handleElevenLabsToolRoute } from "../src/cloudflare-elevenlabs-tools.mjs";

const SECRET = "test-elevenlabs-tool-bearer-secret-at-least-32-characters";

function toolRequest(path, body, authorization = `Bearer ${SECRET}`) {
  return new Request(`https://staging.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("both tool routes require an authenticated ElevenLabs request", async () => {
  for (const path of ["/tools/lookup-onet-career", "/tools/lookup-resource-directory"]) {
    const response = await handleElevenLabsToolRoute(
      toolRequest(path, { query: "project management" }, "Bearer wrong-secret"),
      { ELEVENLABS_TOOL_BEARER_TOKEN: SECRET }
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized." });
  }
});

test("O*NET tool returns bounded verified occupation summaries", async () => {
  const calls = [];
  const response = await handleElevenLabsToolRoute(
    toolRequest("/tools/lookup-onet-career", { query: "project management", limit: 2 }),
    { ELEVENLABS_TOOL_BEARER_TOKEN: SECRET, ONET_API_KEY: "private-onet-key" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      const path = new URL(url).pathname;
      if (path === "/online/search") {
        return Response.json({ occupation: [
          { code: "13-1082.00", title: "Project Management Specialists", tags: { bright_outlook: true } },
          { code: "11-1021.00", title: "General and Operations Managers" }
        ] });
      }
      if (path === "/mnm/careers/13-1082.00/") {
        return Response.json({ code: "13-1082.00", title: "Project Management Specialists", what_they_do: "Coordinate project work.", on_the_job: ["Plan projects"] });
      }
      if (path === "/mnm/careers/11-1021.00/") {
        return Response.json({ code: "11-1021.00", title: "General and Operations Managers", what_they_do: "Plan operations.", on_the_job: ["Direct operations"] });
      }
      return Response.json({}, { status: 404 });
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].title, "Project Management Specialists");
  assert.match(body.results[0].sourceUrl, /^https:\/\/www\.onetonline\.org\//);
  assert.ok(calls.every((call) => call.init.headers["x-api-key"] === "private-onet-key"));
  assert.doesNotMatch(JSON.stringify(body), /private-onet-key/);
});

test("resource directory returns only approved resources and preserves eligibility cautions", async () => {
  const response = await handleElevenLabsToolRoute(
    toolRequest("/tools/lookup-resource-directory", {
      query: "technology job training for a young person",
      location: "San Diego, California",
      limit: 3
    }),
    { ELEVENLABS_TOOL_BEARER_TOKEN: SECRET }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results[0].key, "climb_hire_san_diego");
  assert.match(body.results[0].eligibility, /Eligibility/i);
  assert.ok(body.results.every((resource) => /^https:\/\//.test(resource.url)));
  assert.doesNotMatch(JSON.stringify(body), /evil\.example|participant-secret/);
});

test("tool routes reject malformed or oversized input without reflecting participant data", async () => {
  const malformed = await handleElevenLabsToolRoute(
    toolRequest("/tools/lookup-resource-directory", "{participant-secret"),
    { ELEVENLABS_TOOL_BEARER_TOKEN: SECRET }
  );
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /participant-secret/);

  const oversized = new Request("https://staging.example/tools/lookup-onet-career", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      "content-length": String(17 * 1024)
    },
    body: JSON.stringify({ query: "health careers" })
  });
  const response = await handleElevenLabsToolRoute(oversized, {
    ELEVENLABS_TOOL_BEARER_TOKEN: SECRET,
    ONET_API_KEY: "private-onet-key"
  });
  assert.equal(response.status, 400);
});
