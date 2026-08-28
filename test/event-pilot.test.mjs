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

test("event pilot prepares, checks in, reviews, emails, and syncs a participant", async () => {
  const hubspotRequests = [];
  const googleRequests = [];
  const contacts = new Map();
  let noteSequence = 0;

  const services = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = req.headers["content-type"]?.includes("application/json") && text
      ? JSON.parse(text)
      : text;
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };

    if (req.url === "/token" && req.method === "POST") {
      googleRequests.push({ method: req.method, url: req.url, body });
      send(200, { access_token: "event-email-token", expires_in: 3600 });
      return;
    }
    if (req.url === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
      googleRequests.push({ method: req.method, url: req.url, body });
      send(200, { id: "event-email-1" });
      return;
    }

    if (req.url.startsWith("/crm/")) hubspotRequests.push({ method: req.method, url: req.url, body });
    const contactMatch = req.url.match(/^\/crm\/objects\/2026-03\/contacts\/([^?]+)\?idProperty=email$/);
    if (contactMatch && req.method === "GET") {
      const email = decodeURIComponent(contactMatch[1]);
      if (!contacts.has(email)) {
        send(404, { message: "Contact not found" });
        return;
      }
      send(200, contacts.get(email));
      return;
    }
    const patchMatch = req.url.match(/^\/crm\/objects\/2026-03\/contacts\/([^/?]+)$/);
    if (patchMatch && req.method === "PATCH") {
      const current = [...contacts.values()].find((contact) => contact.id === patchMatch[1]);
      const updated = { ...current, properties: body.properties };
      contacts.set(body.properties.email, updated);
      send(200, updated);
      return;
    }
    if (req.url === "/crm/objects/2026-03/contacts" && req.method === "POST") {
      const contact = { id: `contact-${contacts.size + 1}`, properties: body.properties };
      contacts.set(body.properties.email, contact);
      send(201, contact);
      return;
    }
    if (req.url === "/crm/objects/2026-03/notes" && req.method === "POST") {
      noteSequence += 1;
      send(201, { id: `note-${noteSequence}` });
      return;
    }
    send(404, { message: "Unexpected mock request" });
  });

  const servicesPort = await listen(services);
  const appPort = await availablePort();
  const workDir = await mkdtemp(join(tmpdir(), "pierce-event-test-"));
  const app = spawn(process.execPath, [join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      WORK_DIR: workDir,
      HUBSPOT_SERVICE_KEY: "test-hubspot-key",
      HUBSPOT_API_BASE: `http://127.0.0.1:${servicesPort}`,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_CALENDAR_REFRESH_TOKEN: "test-refresh-token",
      GOOGLE_CALENDAR_ACCOUNT_EMAIL: "voice@pierce.fund",
      GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${servicesPort}/token`,
      GOOGLE_GMAIL_API_BASE: `http://127.0.0.1:${servicesPort}/gmail/v1`
    },
    stdio: "ignore"
  });

  try {
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const slug = "city-highlights-careers";
    await waitForServer(baseUrl);

    for (const path of [
      `/events/${slug}`,
      `/events/${slug}/check-in`,
      `/events/${slug}/mentor`,
      `/events/${slug}/recap`,
      `/events/${slug}/organizer`
    ]) {
      const page = await fetch(`${baseUrl}${path}`);
      assert.equal(page.status, 200);
    }

    const intakeResponse = await fetch(`${baseUrl}/event/intake/participant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_slug: slug,
        guest_name: "Mena Robinson",
        guest_email: "mena@example.com",
        email_confirmed: true,
        guest_city: "San Diego, California",
        career_stage: "Graduate student beginning a career",
        career_goal: "Find an entry point into workforce development",
        primary_challenge: "Choosing a practical first role",
        mentor_questions: [
          "Which roles should I explore first?",
          "What experience would make me a stronger candidate?"
        ],
        resume_url: "https://example.com/resume",
        recording_consent: true,
        information_sharing_consent: true
      })
    });
    const intake = await intakeResponse.json();
    assert.equal(intakeResponse.status, 200);
    assert.equal(intake.hubspot_sync.status, "synced");

    const lookupResponse = await fetch(`${baseUrl}/event/participant/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_slug: slug, guest_name: "Mena Robinson" })
    });
    const lookup = await lookupResponse.json();
    assert.equal(lookup.match_count, 1);
    assert.equal(lookup.matches[0].intake_id, intake.intake_id);

    const checkInResponse = await fetch(`${baseUrl}/event/check-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_slug: slug,
        intake_id: intake.intake_id,
        recording_consent: true
      })
    });
    const checkIn = await checkInResponse.json();
    assert.equal(checkInResponse.status, 200);
    assert.equal(checkIn.hubspot_sync.status, "synced");

    const summaryResponse = await fetch(`${baseUrl}/event/summary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_slug: slug,
        intake_id: intake.intake_id,
        key_guidance: [
          "Start with workforce program coordinator roles.",
          "Use graduate projects as evidence of facilitation skills."
        ],
        mentor_connection: "Max will make one introduction to a local workforce leader.",
        recommended_event: "Attend one local workforce networking event.",
        recommended_resource: "CareerOneStop workforce development career profile.",
        next_step: "Update the resume for program coordinator roles",
        next_step_owner: "Mena",
        next_step_target_date: "2026-09-30",
        participant_approved: true,
        recording_consent: true,
        email_consent: true
      })
    });
    const summary = await summaryResponse.json();
    assert.equal(summaryResponse.status, 200);
    assert.equal(summary.status, "pending_organizer_review");
    assert.equal(googleRequests.length, 0);

    const reviewResponse = await fetch(`${baseUrl}/event/review?slug=${slug}`);
    const review = await reviewResponse.json();
    assert.equal(reviewResponse.status, 200);
    assert.equal(review.summaries.length, 1);
    assert.equal(review.summaries[0].review, null);

    const approvalResponse = await fetch(`${baseUrl}/event/review/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary_id: summary.summary_id, approved: true })
    });
    const approval = await approvalResponse.json();
    assert.equal(approvalResponse.status, 200);
    assert.equal(approval.email_sent, true);
    assert.equal(approval.hubspot_sync.status, "synced");

    const gmailSend = googleRequests.find((request) => request.url.includes("messages/send"));
    const emailText = Buffer.from(gmailSend.body.raw, "base64url").toString("utf8");
    assert.match(emailText, /To: mena@example\.com/);
    assert.match(emailText, /Update the resume for program coordinator roles/);
    assert.match(emailText, /Max will make one introduction/);

    const notes = hubspotRequests.filter(
      (request) => request.method === "POST" && request.url === "/crm/objects/2026-03/notes"
    );
    assert.equal(notes.length, 3);
    assert.match(notes[0].body.properties.hs_note_body, /event participant intake/);
    assert.match(notes[1].body.properties.hs_note_body, /event check in/);
    assert.match(notes[2].body.properties.hs_note_body, /event session summary/);

    const summaryRows = (await readFile(join(workDir, "event-session-summaries.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(summaryRows.length, 2);
    assert.equal(summaryRows[1].record_type, "review");
    assert.equal(summaryRows[1].email_sent, true);
  } finally {
    app.kill("SIGTERM");
    await close(services);
    await rm(workDir, { recursive: true, force: true });
  }
});
