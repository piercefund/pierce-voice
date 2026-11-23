import assert from "node:assert/strict";
import test from "node:test";

import { handleOnetRoute } from "../src/cloudflare-onet.mjs";

test("requires the server-side O*NET API key", async () => {
  const response = await handleOnetRoute(
    new Request("https://staging.example/api/onet/search?q=designer"),
    {}
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, "onet_not_configured");
});

test("searches occupations without exposing the API key", async () => {
  let captured;
  const response = await handleOnetRoute(
    new Request("https://staging.example/api/onet/search?q=project%20manager"),
    { ONET_API_KEY: "test-secret" },
    async (url, init) => {
      captured = { url, init };
      return Response.json({
        total: 1,
        occupation: [{ code: "13-1082.00", title: "Project Management Specialists", tags: { bright_outlook: true } }]
      });
    }
  );
  assert.equal(response.status, 200);
  assert.equal(captured.init.headers["x-api-key"], "test-secret");
  assert.equal(captured.url.includes("test-secret"), false);
  assert.deepEqual((await response.json()).occupations, [{
    code: "13-1082.00",
    title: "Project Management Specialists",
    brightOutlook: true
  }]);
});

test("builds a concise occupation profile from O*NET career services", async () => {
  const responses = new Map([
    ["/mnm/careers/13-1082.00/", {
      code: "13-1082.00",
      title: "Project Management Specialists",
      what_they_do: "Coordinate project work.",
      on_the_job: ["Plan projects", "Coordinate teams"],
      tags: { bright_outlook: true },
      also_called: [{ title: "Project Manager", summary: true }]
    }],
    ["/mnm/careers/13-1082.00/skills", [{ name: "Basic Skills", element: [{ name: "communicating clearly" }] }]],
    ["/mnm/careers/13-1082.00/education", {
      job_zone: { title: "Considerable preparation", education: "Bachelor's degree", experience: "Experience helps", training: "Some training" },
      education_usually_needed: ["bachelor's degree"]
    }],
    ["/mnm/careers/13-1082.00/technology", [{ example: [{ title: "Microsoft Project" }] }]],
    ["/mnm/careers/13-1082.00/explore_more", { careers: [{ code: "11-1021.00", title: "General and Operations Managers" }] }]
  ]);
  const response = await handleOnetRoute(
    new Request("https://staging.example/api/onet/occupations/13-1082.00"),
    { ONET_API_KEY: "test-secret" },
    async (url) => {
      const path = new URL(url).pathname;
      assert.ok(responses.has(path), `unexpected O*NET path: ${path}`);
      return Response.json(responses.get(path));
    }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.occupation.title, "Project Management Specialists");
  assert.deepEqual(body.occupation.technology, ["Microsoft Project"]);
  assert.equal(body.occupation.related[0].title, "General and Operations Managers");
});
