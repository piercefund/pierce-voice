import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function availablePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start at ${url}`);
}

test("booking automatically creates one HubSpot contact and one idempotent note", async () => {
  const requests = [];
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({ method: req.method, url: req.url, body });
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };

    if (req.method === "GET" && req.url.startsWith("/crm/objects/2026-03/contacts/")) {
      send(404, { message: "Contact not found" });
      return;
    }
    if (req.method === "POST" && req.url === "/crm/objects/2026-03/contacts") {
      send(201, { id: "contact-1", properties: body.properties });
      return;
    }
    if (req.method === "POST" && req.url === "/crm/objects/2026-03/notes") {
      send(201, { id: "note-1" });
      return;
    }
    send(404, { message: "Unexpected mock request" });
  });

  const mockPort = await listen(mock);
  const appPort = await availablePort();
  const workDir = await mkdtemp(join(tmpdir(), "pierce-hubspot-test-"));
  const app = spawn(process.execPath, [join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      WORK_DIR: workDir,
      HUBSPOT_SERVICE_KEY: "test-service-key",
      HUBSPOT_API_BASE: `http://127.0.0.1:${mockPort}`
    },
    stdio: "ignore"
  });

  try {
    const baseUrl = `http://127.0.0.1:${appPort}`;
    await waitForServer(baseUrl);
    const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const bookingResponse = await fetch(`${baseUrl}/booking/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guest_name: "Casey Robinson",
        guest_email: "casey@example.com",
        topic: "entrepreneurship",
        date,
        time: "2:00 PM",
        recording_consent: true,
        email_confirmed: true
      })
    });
    assert.equal(bookingResponse.status, 200);
    const booking = await bookingResponse.json();
    assert.equal(booking.hubspot_sync.status, "synced");
    assert.equal(booking.hubspot_sync.duplicate, false);
    assert.equal(booking.hubspot_sync.hubspot_contact_id, "contact-1");

    const firstResponse = await fetch(`${baseUrl}/hubspot/sync/latest-booking`, {
      method: "POST"
    });
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(first.status, "synced");
    assert.equal(first.duplicate, true);

    const secondResponse = await fetch(`${baseUrl}/hubspot/sync/latest-booking`, {
      method: "POST"
    });
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 200);
    assert.equal(second.duplicate, true);

    const careerResponse = await fetch(`${baseUrl}/career-session/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        booking_request_id: first.booking_request_id,
        guest_city: "San Diego, California",
        useful_outcome: "Understand how to launch a useful product",
        career_direction: "Build a voice mentoring product",
        strengths_experience: "Workforce development leadership",
        primary_challenge: "Finding early users",
        recommended_event: {
          name: "Startup networking event",
          format: "in_person",
          reason: "Meet local founders and early users"
        },
        resource_key: "my_next_move",
        next_step: "Talk with an AI startup product leader",
        next_step_target_date: date,
        next_step_confirmed: true,
        recording_consent: true,
        calendar_update_consent: false,
        email_consent: false
      })
    });
    const career = await careerResponse.json();
    assert.equal(careerResponse.status, 200);

    const careerSyncResponse = await fetch(`${baseUrl}/hubspot/sync/career-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: career.session_id })
    });
    const careerSync = await careerSyncResponse.json();
    assert.equal(careerSyncResponse.status, 200);
    assert.equal(careerSync.status, "synced");
    assert.equal(careerSync.duplicate, false);
    assert.equal(careerSync.hubspot_contact_id, "contact-1");

    const duplicateCareerSyncResponse = await fetch(
      `${baseUrl}/hubspot/sync/career-session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: career.session_id })
      }
    );
    const duplicateCareerSync = await duplicateCareerSyncResponse.json();
    assert.equal(duplicateCareerSyncResponse.status, 200);
    assert.equal(duplicateCareerSync.duplicate, true);

    const contactCreates = requests.filter(
      (request) =>
        request.method === "POST" && request.url === "/crm/objects/2026-03/contacts"
    );
    const noteCreates = requests.filter(
      (request) =>
        request.method === "POST" && request.url === "/crm/objects/2026-03/notes"
    );
    assert.equal(contactCreates.length, 1);
    assert.equal(noteCreates.length, 2);
    assert.equal(contactCreates[0].body.properties.email, "casey@example.com");
    assert.equal(
      noteCreates[0].body.associations[0].types[0].associationTypeId,
      202
    );
    assert.match(
      noteCreates[1].body.properties.hs_note_body,
      /Pierce career session summary/
    );
    assert.match(noteCreates[1].body.properties.hs_note_body, /Finding early users/);

    const syncRows = (await readFile(join(workDir, "hubspot-syncs.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(syncRows.at(-1).status, "synced");
    assert.equal(syncRows.at(-1).hubspot_contact_id, "contact-1");
    assert.equal(syncRows.at(-1).source_type, "career_session");
  } finally {
    app.kill("SIGTERM");
    await close(mock);
    await rm(workDir, { recursive: true, force: true });
  }
});
