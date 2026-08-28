import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  } finally {
    socket?.close();
    sockets.close();
    app.kill("SIGTERM");
    await close(upstream);
    await rm(workDir, { recursive: true, force: true });
  }
});
