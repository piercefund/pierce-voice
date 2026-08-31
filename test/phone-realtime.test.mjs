import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const webhookSecret = "pierce-test-webhook-secret";

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

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function waitForServer(url) {
  await waitFor(async () => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }, `Server did not start at ${url}`);
}

function webhookHeaders(body, webhookId, valid = true) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = `${webhookId}.${timestamp}.${body}`;
  const signature = createHmac("sha256", valid ? webhookSecret : "wrong-secret")
    .update(signed)
    .digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`
  };
}

test("signed incoming call reuses Pierce tools and ignores duplicate delivery", async () => {
  const acceptedCalls = [];
  const socketEvents = [];
  let socket;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");

    if (req.method === "POST" && req.url === "/v1/realtime/calls/call-pierce-1/accept") {
      acceptedCalls.push({
        authorization: req.headers.authorization,
        body: JSON.parse(text)
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }

    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (req, rawSocket, head) => {
    sockets.handleUpgrade(req, rawSocket, head, (ws) => {
      socket = ws;
      assert.equal(req.headers.authorization, "Bearer test-openai-key");
      assert.equal(new URL(req.url, "http://localhost").searchParams.get("call_id"), "call-pierce-1");
      ws.on("message", (data) => socketEvents.push(JSON.parse(data.toString("utf8"))));
    });
  });

  const upstreamPort = await listen(upstream);
  const appPort = await availablePort();
  const workDir = await mkdtemp(join(tmpdir(), "pierce-phone-test-"));
  await writeFile(
    join(workDir, "booking-requests.jsonl"),
    `${JSON.stringify({
      request_id: "REQ-PHONE-CHECKIN",
      created_at: "2026-09-01T19:00:00.000Z",
      queue_type: "booking_request",
      status: "calendar_invite_sent",
      confirmation: "PV-TEST",
      guest: {
        name: "Kurling Robinson",
        email: "kurling@fokcus.com",
        topic: "Career session"
      },
      date: "2026-09-01",
      time: "14:00",
      end_time: "14:15",
      timezone: "America/Los_Angeles",
      recording_consent: true
    })}\n`
  );
  await writeFile(
    join(workDir, "career-session-summaries.jsonl"),
    `${JSON.stringify({
      session_id: "SES-PHONE-PRIOR",
      created_at: "2026-08-20T19:00:00.000Z",
      completed_at: "2026-08-20T19:00:00.000Z",
      status: "completed",
      booking_request_id: "REQ-PHONE-PRIOR",
      guest: {
        name: "Kurling Robinson",
        email: "kurling@fokcus.com"
      },
      booking: {
        date: "2026-08-20",
        time: "14:00",
        topic: "Financial trading career"
      },
      discovery: {
        useful_outcome: "learn whether financial brokerage is a realistic path",
        career_direction: "financial trading"
      },
      next_step: {
        action: "Connect with a current or retired Financial Broker",
        target_date: "2026-08-27"
      },
      subject_topic: "Financial Trading Career",
      session_occurrence: 1,
      session_occurrence_label: "Initial Session"
    })}\n`
  );
  const app = spawn(process.execPath, [join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      WORK_DIR: workDir,
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_WEBHOOK_SECRET: webhookSecret,
      OPENAI_API_BASE: `http://127.0.0.1:${upstreamPort}`,
      OPENAI_REALTIME_WS_URL: `ws://127.0.0.1:${upstreamPort}/v1/realtime`
    },
    stdio: "ignore"
  });

  try {
    const baseUrl = `http://127.0.0.1:${appPort}`;
    await waitForServer(baseUrl);
    const body = JSON.stringify({
      id: "event-pierce-1",
      type: "realtime.call.incoming",
      data: { call_id: "call-pierce-1" }
    });

    const rejected = await fetch(`${baseUrl}/webhooks/openai/realtime`, {
      method: "POST",
      headers: webhookHeaders(body, "webhook-invalid", false),
      body
    });
    assert.equal(rejected.status, 400);
    assert.equal(acceptedCalls.length, 0);

    const accepted = await fetch(`${baseUrl}/webhooks/openai/realtime`, {
      method: "POST",
      headers: webhookHeaders(body, "webhook-pierce-1"),
      body
    });
    assert.equal(accepted.status, 200);
    assert.equal(acceptedCalls.length, 1);
    assert.equal(acceptedCalls[0].authorization, "Bearer test-openai-key");
    assert.equal(acceptedCalls[0].body.type, "realtime");
    assert.equal(acceptedCalls[0].body.model, "gpt-realtime-2.1");
    assert.equal(acceptedCalls[0].body.audio.output.voice, "marin");
    assert.equal(acceptedCalls[0].body.audio.input.noise_reduction.type, "near_field");
    assert.equal(acceptedCalls[0].body.audio.input.turn_detection.type, "semantic_vad");
    assert.equal(acceptedCalls[0].body.audio.input.turn_detection.eagerness, "medium");
    assert.equal(acceptedCalls[0].body.audio.input.turn_detection.interrupt_response, false);
    assert.equal(acceptedCalls[0].body.tools[0].name, "select_pierce_journey");

    const duplicate = await fetch(`${baseUrl}/webhooks/openai/realtime`, {
      method: "POST",
      headers: webhookHeaders(body, "webhook-pierce-1"),
      body
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(acceptedCalls.length, 1);

    await waitFor(() => socket && socket.readyState === 1, "Realtime socket did not connect");
    await waitFor(
      () => socketEvents.find((event) => event.type === "response.create"),
      "Pierce did not request the welcome response"
    );

    socket.send(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "response-select",
        call_id: "function-select",
        name: "select_pierce_journey",
        arguments: JSON.stringify({ journey: "book" })
      })
    );
    const bookingUpdate = await waitFor(
      () =>
        socketEvents.find(
          (event) =>
            event.type === "session.update" &&
            event.session.tools.some((tool) => tool.name === "verify_guest_email")
        ),
      "Booking tools were not loaded"
    );
    assert.ok(bookingUpdate.session.tools.some((tool) => tool.name === "prepare_booking_request"));
    assert.equal(bookingUpdate.session.audio.input.noise_reduction.type, "near_field");
    assert.equal(bookingUpdate.session.audio.input.turn_detection.interrupt_response, false);
    assert.match(
      bookingUpdate.session.instructions,
      /What provider comes after the at sign, like Gmail, Yahoo, or Hotmail/
    );
    assert.match(
      bookingUpdate.session.instructions,
      /getting a connection to someone in that career/
    );

    socket.send(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "response-email",
        call_id: "function-email",
        name: "verify_guest_email",
        arguments: JSON.stringify({ guest_email: "kurling at fokcus dot com" })
      })
    );
    const emailOutput = await waitFor(
      () =>
        socketEvents.find(
          (event) =>
            event.type === "conversation.item.create" &&
            event.item.call_id === "function-email"
        ),
      "Email verification did not return a tool result"
    );
    const result = JSON.parse(emailOutput.item.output);
    assert.equal(result.ok, true);
    assert.equal(result.guest_email, "kurling@fokcus.com");
    assert.match(result.message, /character by character/i);

    socket.send(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "response-check-in-select",
        call_id: "function-check-in-select",
        name: "select_pierce_journey",
        arguments: JSON.stringify({ journey: "check_in" })
      })
    );
    const checkInUpdate = await waitFor(
      () =>
        socketEvents.find(
          (event) =>
            event.type === "session.update" &&
            event.session.tools.some((tool) => tool.name === "find_guest_session")
        ),
      "Check-in tools were not loaded"
    );
    assert.match(checkInUpdate.session.instructions, /check-in and career conversation may be recorded/);
    assert.doesNotMatch(checkInUpdate.session.instructions, /this brief check-in may be recorded/i);
    assert.equal(checkInUpdate.session.audio.input.noise_reduction.type, "near_field");
    assert.equal(checkInUpdate.session.audio.input.turn_detection.eagerness, "medium");

    socket.send(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "response-check-in",
        call_id: "function-check-in",
        name: "prepare_check_in_request",
        arguments: JSON.stringify({
          guest_name: "Kurling Robinson",
          recording_consent: true,
          date: "2026-09-01",
          session_time: "2:00 PM",
          topic: "Career session",
          booking_request_id: "REQ-PHONE-CHECKIN"
        })
      })
    );
    const careerHandoffUpdate = await waitFor(
      () =>
        socketEvents.find(
          (event) =>
            event.type === "session.update" &&
            event.session.instructions.includes("The caller just checked in")
        ),
      "Career handoff instructions were not loaded"
    );
    assert.match(careerHandoffUpdate.session.instructions, /Do not ask for consent again/);
    assert.doesNotMatch(careerHandoffUpdate.session.instructions, /second, separate consent/i);
    assert.match(
      careerHandoffUpdate.session.instructions,
      /What would make this session useful today/
    );
    assert.match(careerHandoffUpdate.session.instructions, /For example, San Diego, California/);
    assert.ok(
      careerHandoffUpdate.session.tools.some((tool) => tool.name === "complete_career_session")
    );
    assert.ok(
      careerHandoffUpdate.session.tools.some((tool) => tool.name === "get_career_session_memory")
    );
    assert.ok(
      careerHandoffUpdate.session.tools.some((tool) => tool.name === "verify_guest_email")
    );
    assert.ok(
      !careerHandoffUpdate.session.tools.some((tool) => tool.name === "find_career_session")
    );
    assert.equal(careerHandoffUpdate.session.audio.input.noise_reduction.type, "near_field");

    socket.send(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "response-memory",
        call_id: "function-memory",
        name: "get_career_session_memory",
        arguments: JSON.stringify({
          booking_request_id: "REQ-PHONE-CHECKIN",
          guest_email: "kurling@fokcus.com",
          email_confirmed: true
        })
      })
    );
    const memoryOutput = await waitFor(
      () =>
        socketEvents.find(
          (event) =>
            event.type === "conversation.item.create" &&
            event.item.call_id === "function-memory"
        ),
      "Career memory did not return a tool result"
    );
    const memoryResult = JSON.parse(memoryOutput.item.output);
    assert.equal(memoryResult.ok, true);
    assert.equal(memoryResult.returning_guest, true);
    assert.match(
      memoryResult.previous_session.follow_up_question,
      /current or retired Financial Broker/
    );
    assert.match(memoryResult.message, /previous_session_reflection/);

    socket.send(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "response-complete-career",
        call_id: "function-complete-career",
        name: "complete_career_session",
        arguments: JSON.stringify({
          booking_request_id: "REQ-PHONE-CHECKIN",
          guest_city: "Los Angeles",
          useful_outcome: "choose a realistic next job target",
          career_direction: "operations leadership",
          strengths_experience: "organizing people and improving service quality",
          primary_challenge: "turning broad experience into a focused search",
          previous_session_reflection:
            "I spoke with a retired broker and learned the licensing path takes focused study.",
          recommended_event: {
            name: "local professional networking event",
            format: "in person",
            reason: "it gives practice explaining the career direction out loud"
          },
          resource_key: "career_one_stop",
          next_step: "write a one-page target role list",
          next_step_target_date: "September 10, 2026",
          next_step_confirmed: true,
          recording_consent: true,
          email_consent: false
        })
      })
    );
    const careerOutput = await waitFor(
      () =>
        socketEvents.find(
          (event) =>
            event.type === "conversation.item.create" &&
            event.item.call_id === "function-complete-career"
        ),
      "Career session did not return a tool result"
    );
    const careerResult = JSON.parse(careerOutput.item.output);
    assert.equal(careerResult.ok, true);
    assert.equal(careerResult.recommended_event.format, "in_person");
    assert.equal(careerResult.next_step_target_date, "2026-09-10");

    const savedSessions = (await readFile(join(workDir, "career-session-summaries.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(savedSessions.length, 2);
    assert.equal(savedSessions[1].booking_request_id, "REQ-PHONE-CHECKIN");
    assert.equal(savedSessions[1].next_step.target_date, "2026-09-10");
    assert.match(savedSessions[1].previous_session_reflection, /retired broker/);
  } finally {
    socket?.close();
    sockets.close();
    app.kill("SIGTERM");
    await close(upstream);
    await rm(workDir, { recursive: true, force: true });
  }
});
