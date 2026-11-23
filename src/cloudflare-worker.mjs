import { handleBookingRoute } from "./cloudflare-booking.mjs";
import { sendGmail } from "./cloudflare-google-api.mjs";

let WorkerEntrypoint = class {};
if (typeof WebSocketPair !== "undefined") {
  ({ WorkerEntrypoint } = await import("cloudflare:workers"));
}

export class PitchScorecardMailer extends WorkerEntrypoint {
  async sendScorecard(message) {
    if (!message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to) ||
        ![1, 2, 3].includes(message.round) || typeof message.text !== "string" ||
        message.text.length > 12000 || !message.text.startsWith("Perfect YOUR Investor Pitch")) {
      throw new Error("Invalid pitch scorecard email");
    }
    const result = await sendGmail(this.env, {
      to: message.to,
      subject: `Your pitch scorecard - Round ${message.round}`,
      body: message.text
    });
    return { messageId: result.id };
  }
}
import { accessIdentity } from "./cloudflare-access.mjs";
import { handleCareerRoute } from "./cloudflare-career.mjs";
import { handleCustomLlmRoute } from "./cloudflare-custom-llm.mjs";
import { handleElevenLabsToolRoute } from "./cloudflare-elevenlabs-tools.mjs";
import { handleDataManagementRoute } from "./cloudflare-data-management.mjs";
import { handleEventRoute } from "./cloudflare-events.mjs";
import { handleGoogleRoute } from "./cloudflare-google.mjs";
import { handleGuestTakeawayRoute } from "./cloudflare-guest-takeaway.mjs";
import { handleHubspotRoute, processHubspotQueue } from "./cloudflare-hubspot.mjs";
import { handleMentoringRoute } from "./cloudflare-mentoring.mjs";
import { handleOnetRoute } from "./cloudflare-onet.mjs";
import { handlePhoneWebhook, PiercePhoneCall } from "./cloudflare-phone.mjs";
import { handleSmsRoute, PierceEmailLink } from "./cloudflare-sms.mjs";
import { handleStartupWeekRoute } from "./cloudflare-startup-week.mjs";

export { PierceEmailLink, PiercePhoneCall };

const MAX_SDP_BYTES = 1024 * 1024;

export function isOrganizerPath(pathname) {
  return pathname === "/organizer" || pathname === "/organizer.html" ||
    pathname === "/mentor-review" ||
    pathname.startsWith("/organizer/data/") ||
    pathname === "/event/review" ||
    pathname === "/event/review/approve" || pathname === "/event/review/bookings" ||
    pathname === "/event/review/mentors" ||
    /^\/events\/[^/]+\/organizer\/?$/.test(pathname);
}

function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function prepareStagingAsset(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("text/html")) return response;

  return new HTMLRewriter()
    .on(".phone-option", {
      element(element) {
        element.setInnerContent(
          "Cloudflare staging: browser voice only. Phone mode is disabled."
        );
      }
    })
    .transform(response);
}

function assetRequest(request, url) {
  if (url.pathname === "/email") {
    const emailUrl = new URL(request.url);
    emailUrl.pathname = "/email.html";
    emailUrl.search = "";
    return new Request(emailUrl, request);
  }
  if (url.pathname === "/mentor") {
    const participantUrl = new URL(request.url);
    participantUrl.pathname = "/index.html";
    participantUrl.search = "";
    return new Request(participantUrl, request);
  }
  if (url.pathname === "/mentor-board") {
    const boardUrl = new URL(request.url);
    boardUrl.pathname = "/mentor-board.html";
    boardUrl.search = "";
    return new Request(boardUrl, request);
  }
  if (["/organizer", "/mentor-review"].includes(url.pathname) ||
      /^\/events\/[^/]+\/organizer\/?$/.test(url.pathname)) {
    const organizerUrl = new URL(request.url);
    organizerUrl.pathname = "/organizer.html";
    organizerUrl.search = "";
    return new Request(organizerUrl, request);
  }
  return request;
}

function prepareAssetResponse(response, url, env) {
  if (isOrganizerPath(url.pathname)) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("content-security-policy",
      "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  if (!["/email", "/email.html"].includes(url.pathname)) {
    return env.PIERCE_ENV === "staging" ? prepareStagingAsset(response) : response;
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function readBoundedText(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RangeError("Request body is too large.");
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new RangeError("Request body is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

async function createRealtimeSession(request, env) {
  if (!env.OPENAI_API_KEY) {
    return new Response("OPENAI_API_KEY is not configured.", {
      status: 503
    });
  }

  let sdp;
  try {
    sdp = await readBoundedText(request, MAX_SDP_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return new Response(error.message, { status: 413 });
    }
    throw error;
  }

  if (!sdp.trim()) {
    return new Response("Missing SDP offer.", { status: 400 });
  }

  const session = {
    type: "realtime",
    model: env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
    instructions:
      "You are Pierce, a friendly voice assistant. Wait for the client session update before responding.",
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,
          interrupt_response: false
        }
      },
      output: { voice: "marin" }
    }
  };

  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(session));

  const apiBase = (env.OPENAI_API_BASE || "https://api.openai.com").replace(/\/$/, "");
  const upstream = await fetch(`${apiBase}/v1/realtime/calls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: {
      "content-type": upstream.ok
        ? "application/sdp"
        : upstream.headers.get("content-type") || "text/plain; charset=utf-8"
    }
  });
}

async function persistenceStatus(env) {
  if (!env.PIERCE_DATA) {
    return json({ ok: false, binding: false, reason: "r2_not_configured" }, { status: 503 });
  }

  const keys = {
    bookings: "pierce-data/booking-requests.jsonl",
    check_ins: "pierce-data/check-in-requests.jsonl",
    career_summaries: "pierce-data/career-session-summaries.jsonl",
    event_intakes: "pierce-data/event-intakes.jsonl",
    event_check_ins: "pierce-data/event-check-ins.jsonl",
    event_summaries: "pierce-data/event-session-summaries.jsonl",
    mentor_bookings: "pierce-data/event-mentor-bookings.jsonl"
  };
  const objects = {};
  try {
    for (const [name, key] of Object.entries(keys)) {
      const object = await env.PIERCE_DATA.head(key);
      objects[name] = {
        exists: Boolean(object),
        size: object?.size || 0
      };
    }
  } catch (error) {
    console.error("R2 persistence diagnostic failed", error);
    return json({ ok: false, binding: true, reason: "r2_unavailable" }, { status: 503 });
  }

  const bucket = env.PIERCE_ENV === "production"
    ? "pierce-voice-production-data"
    : "pierce-voice-staging-data";
  return json({ ok: true, binding: true, bucket, objects });
}

export async function handleRequest(request, env, ctx = null) {
  const url = new URL(request.url);
  const organizerPath = isOrganizerPath(url.pathname);
  const organizer = organizerPath ? await accessIdentity(request, env, ctx) : null;
  if (organizerPath && !organizer) {
    return json({ ok: false, reason: "organizer_access_required" }, {
      status: 403,
      headers: { "cache-control": "no-store" }
    });
  }
  if (request.method === "GET" && url.pathname === "/mentor-review") {
    const organizerUrl = new URL(request.url);
    organizerUrl.pathname = "/events/san-diego-startup-week-mentoring/organizer";
    organizerUrl.search = "";
    return Response.redirect(organizerUrl, 302);
  }

  if (request.method === "GET" && url.pathname === "/__cloudflare/health") {
    return json({
      ok: true,
      service: "pierce-voice",
      environment: env.PIERCE_ENV || "unknown",
      capabilities: {
        static_assets: true,
        browser_realtime_session: true,
        booking_check_in_persistence: Boolean(env.PIERCE_DATA),
        career_session_persistence: Boolean(env.PIERCE_DATA),
        event_persistence: Boolean(env.PIERCE_DATA),
        mentor_scheduling: Boolean(env.PIERCE_DATA && env.GOOGLE_CLIENT_ID &&
          env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALENDAR_REFRESH_TOKEN),
        google_calendar_gmail: Boolean(
          env.GOOGLE_CLIENT_ID &&
          env.GOOGLE_CLIENT_SECRET &&
          env.GOOGLE_CALENDAR_REFRESH_TOKEN
        ),
        organizer_access: Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD),
        hubspot_queue: Boolean(env.HUBSPOT_SYNC_QUEUE && env.HUBSPOT_SERVICE_KEY),
        stateful_workflows: Boolean(env.PHONE_CALLS),
        phone_webhook: Boolean(
          env.PHONE_CALLS && env.OPENAI_API_KEY && env.OPENAI_WEBHOOK_SECRET
        ),
        secure_email_links: Boolean(env.EMAIL_LINKS),
        onet_career_explorer: Boolean(env.ONET_API_KEY),
        one_time_sms: Boolean(
          env.EMAIL_LINKS && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN &&
          (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER)
        ),
        elevenlabs_custom_llm: Boolean(env.AI && env.ELEVENLABS_LLM_BEARER_TOKEN)
      }
    });
  }

  if (request.method === "GET" && url.pathname === "/__cloudflare/persistence") {
    return persistenceStatus(env);
  }

  if (request.method === "POST" && url.pathname === "/session") {
    return createRealtimeSession(request, env);
  }

  const customLlmResponse = await handleCustomLlmRoute(request, env);
  if (customLlmResponse) return customLlmResponse;

  const elevenLabsToolResponse = await handleElevenLabsToolRoute(request, env);
  if (elevenLabsToolResponse) return elevenLabsToolResponse;

  const phoneResponse = await handlePhoneWebhook(request, env);
  if (phoneResponse) return phoneResponse;

  const smsResponse = await handleSmsRoute(request, env);
  if (smsResponse) return smsResponse;

  const googleResponse = await handleGoogleRoute(request, env);
  if (googleResponse) return googleResponse;

  const guestTakeawayResponse = await handleGuestTakeawayRoute(request, env);
  if (guestTakeawayResponse) return guestTakeawayResponse;

  const bookingResponse = await handleBookingRoute(request, env);
  if (bookingResponse) return bookingResponse;

  const careerResponse = await handleCareerRoute(request, env);
  if (careerResponse) return careerResponse;

  const onetResponse = await handleOnetRoute(request, env);
  if (onetResponse) return onetResponse;

  const startupWeekResponse = await handleStartupWeekRoute(request, env);
  if (startupWeekResponse) return startupWeekResponse;

  const eventResponse = await handleEventRoute(request, env, organizer);
  if (eventResponse) return eventResponse;

  const dataManagementResponse = await handleDataManagementRoute(request, env, organizer);
  if (dataManagementResponse) return dataManagementResponse;

  const mentoringResponse = await handleMentoringRoute(request, env, organizer);
  if (mentoringResponse) return mentoringResponse;

  const hubspotResponse = await handleHubspotRoute(request, env);
  if (hubspotResponse) return hubspotResponse;

  const assetResponse = await env.ASSETS.fetch(assetRequest(request, url));
  return prepareAssetResponse(assetResponse, url, env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Unhandled Cloudflare request error",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error)
        })
      );
      return json({ ok: false, reason: "internal_error" }, { status: 500 });
    }
  },
  async queue(batch, env) {
    await processHubspotQueue(batch, env);
  }
};
