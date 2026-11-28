import assert from "node:assert/strict";
import test from "node:test";

import {
  handleCustomLlmRoute,
  PIERCE_MODEL,
  PIERCE_SAFETY_POLICY
} from "../src/cloudflare-custom-llm.mjs";

const SECRET = "test-elevenlabs-bearer-secret-at-least-32-characters";

function stream(...events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

function request(body, options = {}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${SECRET}`,
    ...options.headers
  };
  return new Request("https://staging.example/v1/chat/completions", {
    method: options.method || "POST",
    headers,
    body: options.rawBody === undefined ? JSON.stringify(body) : options.rawBody
  });
}

function env(run) {
  return {
    ELEVENLABS_LLM_BEARER_TOKEN: SECRET,
    AI: { run }
  };
}

function baseBody(overrides = {}) {
  return {
    model: "unapproved-model",
    stream: true,
    messages: [
      { role: "system", content: "Keep the session warm and concise." },
      { role: "user", content: "I want to explore health careers." }
    ],
    ...overrides
  };
}

async function ssePayloads(response) {
  return (await response.text())
    .split(/\n\n/)
    .map((event) => event.trim())
    .filter((event) => event.startsWith("data: "))
    .map((event) => event.slice(6))
    .filter((data) => data !== "[DONE]")
    .map(JSON.parse);
}

test("requires the dedicated bearer secret before invoking Workers AI", async () => {
  let invoked = false;
  const response = await handleCustomLlmRoute(
    request(baseBody(), { headers: { authorization: "Bearer wrong-secret" } }),
    env(async () => { invoked = true; })
  );

  assert.equal(response.status, 401);
  assert.equal(invoked, false);
  assert.deepEqual(await response.json(), {
    error: { message: "The request could not be processed.", type: "authentication_error" }
  });
});

test("always uses Granite, prepends Pierce policy, caps output, and streams OpenAI chunks", async () => {
  let invocation;
  const response = await handleCustomLlmRoute(request(baseBody({ max_tokens: 99999 })), env(
    async (model, input) => {
      invocation = { model, input };
      return stream(
        { response: "A health information technician path " },
        {
          choices: [{
            delta: { content: "could fit.", reasoning_content: "private reasoning" },
            finish_reason: "stop"
          }],
          reasoning_content: "also private"
        }
      );
    }
  ));

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(invocation.model, PIERCE_MODEL);
  assert.equal(invocation.input.max_tokens, 768);
  assert.equal(invocation.input.stream, true);
  assert.ok(invocation.input.messages[0].content.startsWith(PIERCE_SAFETY_POLICY));
  assert.match(invocation.input.messages[0].content, /Keep the session warm and concise/);
  const text = await response.text();
  assert.match(text, /health information technician path/);
  assert.match(text, /could fit/);
  assert.doesNotMatch(text, /private reasoning|reasoning_content/);
  assert.doesNotMatch(text, /unapproved-model/);
});

test("passes approved tool definitions and emits approved tool calls", async () => {
  let invocation;
  const body = baseBody({
    tools: [{
      type: "function",
      function: {
        name: "lookup_onet_career",
        description: "Look up verified O*NET career data.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false
        }
      }
    }]
  });
  const response = await handleCustomLlmRoute(request(body), env(async (model, input) => {
    invocation = input;
    return stream({
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "lookup_onet_career", arguments: { query: "health data" } }
      }],
      choices: [{ delta: {}, finish_reason: "tool_calls" }]
    });
  }));

  assert.equal(response.status, 200);
  assert.equal(invocation.tools[0].function.name, "lookup_onet_career");
  const payloads = await ssePayloads(response);
  const toolChunk = payloads.find((payload) => payload.choices[0].delta.tool_calls);
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, "lookup_onet_career");
  assert.equal(toolChunk.choices[0].finish_reason, null);
  assert.equal(payloads.at(-1).choices[0].finish_reason, "tool_calls");
});

test("rejects unapproved tools before model inference", async () => {
  let invoked = false;
  const response = await handleCustomLlmRoute(request(baseBody({
    tools: [{
      type: "function",
      function: {
        name: "read_arbitrary_secret",
        description: "Not allowed.",
        parameters: { type: "object" }
      }
    }]
  })), env(async () => { invoked = true; }));

  assert.equal(response.status, 400);
  assert.equal(invoked, false);
  assert.doesNotMatch(await response.text(), /read_arbitrary_secret/);
});

test("rejects malformed and oversized requests without reflecting participant data", async () => {
  const malformed = await handleCustomLlmRoute(
    request(null, { rawBody: "{participant-secret" }),
    env(async () => { throw new Error("should not run"); })
  );
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /participant-secret/);

  const oversized = await handleCustomLlmRoute(
    request(baseBody(), { headers: { "content-length": String(129 * 1024) } }),
    env(async () => { throw new Error("should not run"); })
  );
  assert.equal(oversized.status, 413);
});

test("returns a generic upstream error without leaking model or participant details", async () => {
  const response = await handleCustomLlmRoute(
    request(baseBody({ messages: [{ role: "user", content: "private participant answer" }] })),
    env(async () => { throw new Error("provider failure includes private participant answer"); })
  );
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /private participant answer|provider failure/);
  assert.match(text, /upstream_error/);
});

test("ends a repeated directory lookup and suppresses split planning tags", async () => {
  const call = {
    id: "directory-1",
    type: "function",
    function: { name: "lookup_resource_directory", arguments: '{"query":"beginner AI"}' }
  };
  const body = baseBody();
  body.messages.push(
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", content: '{"results":[]}', tool_call_id: call.id }
  );
  body.tools = [{
    type: "function",
    function: { name: call.function.name, parameters: { type: "object" } }
  }];
  const response = await handleCustomLlmRoute(request(body), env(async (_model, input) => {
    assert.deepEqual(input.tools, input.stream ? [] : undefined);
    return stream(
      { response: "[th" },
      { response: "ought] I will search again." },
      { tool_calls: [call] }
    );
  }));
  const chunks = await ssePayloads(response);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.match(JSON.stringify(chunks), /Please try again in a new session/);
  assert.doesNotMatch(JSON.stringify(chunks), /thought|search again|lookup_resource_directory/);
});

test("keeps the resource lookup available when recap confirmation includes a question", async () => {
  const body = baseBody({
    messages: [{ role: "user", content: "It does, and I'm in San Diego. Is there anything in San Diego" }],
    tools: ["end_call", "complete_career_session", "prepare_guest_recap", "lookup_resource_directory"]
      .map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } }))
  });
  const response = await handleCustomLlmRoute(request(body), env(async (_model, input) => {
    assert.deepEqual(input.tools.map(({ function: tool }) => tool.name), ["lookup_resource_directory"]);
    return stream({ response: "I can help you explore San Diego options." });
  }));
  assert.equal((await ssePayloads(response)).at(-1).choices[0].finish_reason, "stop");
});

test("recovers from planning-only output with one direct reply", async () => {
  let calls = 0;
  const body = baseBody();
  body.messages.push(
    { role: "assistant", content: "I’m having trouble responding right now. Please try again in a new session." },
    { role: "user", content: "I am interested in financial planning." }
  );
  const response = await handleCustomLlmRoute(request(body), env(async (_model, input) => {
    calls += 1;
    if (calls === 1) return stream({ response: "[thought] private planning" });
    assert.equal(input.tools, undefined);
    assert.match(input.messages[0].content, /Answer the guest directly/);
    assert.deepEqual(input.messages.slice(1).map(({ role }) => role), ["user", "user"]);
    assert.equal(input.stream, false);
    return { choices: [{ message: { content: "Which health career interests you most?" } }] };
  }));
  const output = await response.text();
  assert.equal(calls, 2);
  assert.match(output, /Which health career interests you most/);
  assert.doesNotMatch(output, /private planning|couldn.t finish/);
});

test("does not speak plain-text directory instructions or an assumed city", async () => {
  const response = await handleCustomLlmRoute(request(baseBody()), env(async (_model, input) =>
    input.stream
      ? stream({ response: "lookup resource " }, { response: "directory financial planning location San Diego" })
      : { response: "What city and state are you in?" }
  ));
  const output = await response.text();
  assert.match(output, /What city and state are you in/);
  assert.doesNotMatch(output, /lookup resource directory|San Diego/);
});
