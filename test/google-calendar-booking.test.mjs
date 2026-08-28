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

function futureDate(days = 45) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test("connected Calendar checks availability and sends one idempotent invitation", async () => {
  const requests = [];
  let availabilityChecks = 0;
  const google = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = req.headers["content-type"]?.includes("application/json") && text
      ? JSON.parse(text)
      : text;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });

    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };

    if (req.method === "POST" && req.url === "/token") {
      send(200, { access_token: "calendar-access-token", expires_in: 3600 });
      return;
    }
    if (req.method === "POST" && req.url === "/calendar/v3/freeBusy") {
      availabilityChecks += 1;
      send(200, {
        calendars: {
          primary: {
            busy: availabilityChecks === 1
              ? []
              : [{ start: body.timeMin, end: body.timeMax }]
          }
        }
      });
      return;
    }
    if (
      req.method === "POST" &&
      req.url ===
        "/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=0"
    ) {
      send(200, {
        id: body.id,
        htmlLink: `https://calendar.google.com/event?eid=${body.id}`,
        extendedProperties: body.extendedProperties
      });
      return;
    }
    if (req.method === "POST" && req.url === "/gmail/v1/users/me/messages/send") {
      send(200, { id: "gmail-message-1" });
      return;
    }
    send(404, { error: { message: "Unexpected Google mock request" } });
  });

  const googlePort = await listen(google);
  const appPort = await availablePort();
  const workDir = await mkdtemp(join(tmpdir(), "pierce-calendar-test-"));
  const app = spawn(process.execPath, [join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      WORK_DIR: workDir,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_CALENDAR_REFRESH_TOKEN: "test-refresh-token",
      GOOGLE_CALENDAR_ACCOUNT_EMAIL: "voice@pierce.fund",
      PIERCE_CALENDAR_OWNER_EMAIL: "voice@pierce.fund",
      GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${googlePort}/token`,
      GOOGLE_CALENDAR_API_BASE: `http://127.0.0.1:${googlePort}/calendar/v3`,
      GOOGLE_GMAIL_API_BASE: `http://127.0.0.1:${googlePort}/gmail/v1`
    },
    stdio: "ignore"
  });

  try {
    const baseUrl = `http://127.0.0.1:${appPort}`;
    await waitForServer(baseUrl);
    const checkInPage = await fetch(`${baseUrl}/check-in`);
    assert.equal(checkInPage.status, 200);
    assert.match(await checkInPage.text(), /Pierce/);
    const date = futureDate();
    const bookingPayload = {
      guest_name: "Casey Robinson",
      guest_email: "casey@example.com",
      topic: "career planning & training",
      date,
      time: "2:00 PM",
      recording_consent: true,
      email_confirmed: true
    };
    const bookedResponse = await fetch(`${baseUrl}/booking/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bookingPayload)
    });
    const booked = await bookedResponse.json();

    assert.equal(bookedResponse.status, 200);
    assert.equal(booked.booked, true);
    assert.equal(booked.invite_sent, true);
    assert.equal(booked.queued, false);
    assert.match(booked.confirmation, /^PIERCE-[A-F0-9]{8}$/);

    const insert = requests.find(
      (request) => request.method === "POST" && request.url.includes("/events?sendUpdates=all")
    );
    assert.equal(insert.authorization, "Bearer calendar-access-token");
    assert.match(insert.body.id, /^pierce[0-9a-v]{32}$/);
    assert.equal(insert.body.attendees[0].email, "casey@example.com");
    assert.equal(insert.body.start.timeZone, "America/Los_Angeles");
    assert.equal(insert.body.end.timeZone, "America/Los_Angeles");
    assert.match(insert.body.description, new RegExp(booked.confirmation));
    assert.match(
      insert.body.description,
      /https:\/\/voice\.pierce\.fund\/check-in/
    );
    assert.match(insert.body.description, /career planning &amp; training/);
    assert.match(
      insert.body.description,
      /<h2>Check in at your appointment time<\/h2>/
    );
    assert.match(insert.body.description, />Check in with Pierce<\/strong><\/a>/);
    assert.equal(insert.body.location, undefined);
    assert.equal(insert.body.conferenceData, undefined);

    const careerResponse = await fetch(`${baseUrl}/career-session/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        booking_request_id: booked.request_id,
        guest_city: "San Diego, California",
        useful_outcome: "Choose a practical career direction",
        career_direction: "Licensed vocational nursing",
        strengths_experience: "Helping people and working with a team",
        primary_challenge: "Understanding the training path",
        recommended_event: {
          name: "Local nursing program information session",
          format: "in_person",
          reason: "Compare nearby training options and admission requirements"
        },
        resource_key: "my_next_move",
        next_step: "Compare two LVN programs",
        next_step_target_date: date,
        next_step_confirmed: true,
        recording_consent: true,
        email_consent: true
      })
    });
    const career = await careerResponse.json();
    assert.equal(careerResponse.status, 200);
    assert.equal(career.email_sent, true);
    assert.equal(career.email_queued, false);
    assert.equal(career.calendar_update_queued, false);

    const gmailSend = requests.find(
      (request) => request.method === "POST" && request.url === "/gmail/v1/users/me/messages/send"
    );
    assert.equal(gmailSend.authorization, "Bearer calendar-access-token");
    const emailText = Buffer.from(gmailSend.body.raw, "base64url").toString("utf8");
    assert.match(emailText, /To: casey@example\.com/);
    assert.match(emailText, /Subject: Your Pierce career session: next steps/);
    assert.match(emailText, /Compare two LVN programs/);

    const unavailableResponse = await fetch(`${baseUrl}/booking/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...bookingPayload,
        guest_name: "Jordan Lee",
        guest_email: "jordan@example.com"
      })
    });
    const unavailable = await unavailableResponse.json();
    assert.equal(unavailableResponse.status, 409);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.reason, "slot_unavailable");

    const tokenRequests = requests.filter((request) => request.url === "/token");
    const inserts = requests.filter((request) => request.url.includes("/events?sendUpdates=all"));
    assert.equal(tokenRequests.length, 1);
    assert.equal(inserts.length, 1);

    const rows = (await readFile(join(workDir, "booking-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "booked_google_calendar");
    assert.equal(rows[0].event_id, booked.event_id);

    const emailRows = (await readFile(join(workDir, "follow-up-emails.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(emailRows[0].status, "sent");
    assert.equal(emailRows[0].provider_message_id, "gmail-message-1");
  } finally {
    app.kill("SIGTERM");
    await close(google);
    await rm(workDir, { recursive: true, force: true });
  }
});

test("local OAuth setup stores only the verified Pierce Calendar refresh token", async () => {
  const google = createServer(async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/token") {
      res.end(JSON.stringify({
        access_token: "setup-access-token",
        refresh_token: "setup-refresh-token",
        expires_in: 3600
      }));
      return;
    }
    if (req.url === "/userinfo") {
      assert.equal(req.headers.authorization, "Bearer setup-access-token");
      res.end(JSON.stringify({ email: "voice@pierce.fund", email_verified: true }));
      return;
    }
    res.end(JSON.stringify({ error: "unexpected request" }));
  });

  const googlePort = await listen(google);
  const appPort = await availablePort();
  const workDir = await mkdtemp(join(tmpdir(), "pierce-calendar-oauth-test-"));
  const app = spawn(process.execPath, [join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      WORK_DIR: workDir,
      GOOGLE_CLIENT_ID: "setup-client-id",
      GOOGLE_CLIENT_SECRET: "setup-client-secret",
      PIERCE_CALENDAR_OWNER_EMAIL: "voice@pierce.fund",
      GOOGLE_OAUTH_REDIRECT_URI: `http://localhost:${appPort}/calendar/oauth/callback`,
      GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${googlePort}/token`,
      GOOGLE_OAUTH_USERINFO_URL: `http://127.0.0.1:${googlePort}/userinfo`,
      GOOGLE_CALENDAR_REFRESH_TOKEN: "",
      GOOGLE_REFRESH_TOKEN: ""
    },
    stdio: "ignore"
  });

  try {
    const baseUrl = `http://127.0.0.1:${appPort}`;
    await waitForServer(baseUrl);
    const connect = await fetch(`${baseUrl}/calendar/connect`, { redirect: "manual" });
    assert.equal(connect.status, 302);
    const authorizationUrl = new URL(connect.headers.get("location"));
    assert.equal(authorizationUrl.hostname, "accounts.google.com");
    assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
    assert.equal(authorizationUrl.searchParams.get("login_hint"), "voice@pierce.fund");
    assert.match(
      authorizationUrl.searchParams.get("scope"),
      /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/
    );

    const callback = await fetch(
      `${baseUrl}/calendar/oauth/callback?code=test-code&state=${authorizationUrl.searchParams.get("state")}`
    );
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /Google connected/);

    const stored = JSON.parse(
      await readFile(join(workDir, "google-calendar-oauth.json"), "utf8")
    );
    assert.equal(stored.refresh_token, "setup-refresh-token");
    assert.equal(stored.account_email, "voice@pierce.fund");
    assert.equal(stored.access_token, undefined);

    const status = await fetch(`${baseUrl}/calendar/status`);
    assert.deepEqual(await status.json(), {
      ok: true,
      connected: true,
      email_connected: true,
      expected_account: "voice@pierce.fund",
      connected_account: "voice@pierce.fund",
      calendar_id: "primary",
      reason: ""
    });
  } finally {
    app.kill("SIGTERM");
    await close(google);
    await rm(workDir, { recursive: true, force: true });
  }
});
