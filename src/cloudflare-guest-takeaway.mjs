import { isEmail, normalizeSpokenEmail } from "./cloudflare-booking.mjs";
import { googleConfigured, sendGmail } from "./cloudflare-google-api.mjs";

const MAX_JSON_BYTES = 16 * 1024;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const DELIVERY_PREFIX = "pierce-data/guest-takeaway-deliveries/";
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    }
  });
}

async function requestJson(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new RangeError("Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new RangeError("Request body is too large.");
  }
  return JSON.parse(text || "{}");
}

function deliveryKey(deliveryId) {
  return `${DELIVERY_PREFIX}${deliveryId}.json`;
}

async function recipientHash(email) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createGuestTakeaway(env, { kind = "summary", subject, body } = {}) {
  const cleanSubject = String(subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 180);
  const cleanBody = String(body || "").trim().slice(0, 48 * 1024);
  if (!env?.PIERCE_DATA || !googleConfigured(env) || !cleanSubject || !cleanBody) {
    return { delivery_id: "", email_available: false };
  }

  const deliveryId = crypto.randomUUID();
  const createdAt = new Date();
  const delivery = {
    version: 1,
    delivery_id: deliveryId,
    kind: String(kind || "summary").slice(0, 80),
    status: "active",
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + DELIVERY_TTL_MS).toISOString(),
    subject: cleanSubject,
    body: cleanBody
  };

  try {
    const stored = await env.PIERCE_DATA.put(
      deliveryKey(deliveryId),
      JSON.stringify(delivery),
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json; charset=utf-8" }
      }
    );
    return {
      delivery_id: stored ? deliveryId : "",
      email_available: Boolean(stored)
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: "guest_takeaway_delivery_create_failed",
      kind: delivery.kind,
      error: error instanceof Error ? error.message : String(error)
    }));
    return { delivery_id: "", email_available: false };
  }
}

async function emailGuestTakeaway(request, env) {
  const body = await requestJson(request);
  if (String(body.company || "").trim()) {
    return json({ ok: false, reason: "invalid_request" }, 400);
  }
  const deliveryId = String(body.delivery_id || "").trim();
  const email = normalizeSpokenEmail(body.guest_email);
  if (!DELIVERY_ID_PATTERN.test(deliveryId) || !isEmail(email) || body.email_consent !== true) {
    return json({ ok: false, reason: "email_and_consent_required" }, 400);
  }
  if (!env?.PIERCE_DATA || !googleConfigured(env)) {
    return json({ ok: false, reason: "guest_takeaway_email_not_configured" }, 503);
  }

  const key = deliveryKey(deliveryId);
  const object = await env.PIERCE_DATA.get(key);
  if (!object) return json({ ok: false, reason: "takeaway_expired" }, 404);

  let delivery;
  try {
    delivery = JSON.parse(await object.text());
  } catch {
    return json({ ok: false, reason: "takeaway_unavailable" }, 503);
  }
  if (Date.parse(delivery.expires_at) <= Date.now()) {
    if (typeof env.PIERCE_DATA.delete === "function") await env.PIERCE_DATA.delete(key);
    return json({ ok: false, reason: "takeaway_expired" }, 404);
  }
  if (delivery.status === "sent") {
    return json({ ok: true, duplicate: true, email_status: "sent" });
  }
  if (delivery.status !== "active") {
    return json({ ok: false, reason: "email_delivery_in_progress" }, 409);
  }

  const processing = {
    ...delivery,
    status: "processing",
    processing_at: new Date().toISOString()
  };
  const locked = await env.PIERCE_DATA.put(key, JSON.stringify(processing), {
    onlyIf: { etagMatches: object.etag },
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
  if (!locked) return json({ ok: false, reason: "email_delivery_in_progress" }, 409);

  let providerMessageId = "";
  try {
    const sent = await sendGmail(env, {
      to: email,
      subject: processing.subject,
      body: processing.body
    });
    providerMessageId = String(sent.id || "");
  } catch (error) {
    await env.PIERCE_DATA.put(key, JSON.stringify({
      ...delivery,
      last_error_at: new Date().toISOString()
    }), {
      onlyIf: { etagMatches: locked.etag },
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    console.error(JSON.stringify({
      event: "guest_takeaway_email_send_failed",
      delivery_id: deliveryId,
      kind: processing.kind,
      error: error instanceof Error ? error.message : String(error)
    }));
    return json({ ok: false, reason: "email_delivery_failed" }, 502);
  }

  const completed = {
    ...processing,
    status: "sent",
    sent_at: new Date().toISOString(),
    recipient_hash: await recipientHash(email),
    provider_message_id: providerMessageId
  };
  delete completed.processing_at;
  const saved = await env.PIERCE_DATA.put(key, JSON.stringify(completed), {
    onlyIf: { etagMatches: locked.etag },
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
  if (!saved) {
    console.warn(JSON.stringify({
      event: "guest_takeaway_email_sent_status_not_saved",
      delivery_id: deliveryId,
      kind: processing.kind
    }));
  }
  return json({ ok: true, email_status: "sent" });
}

export async function handleGuestTakeawayRoute(request, env) {
  const pathname = new URL(request.url).pathname;
  if (request.method !== "POST" || !["/guest-takeaway/email", "/startup-week/email"].includes(pathname)) {
    return null;
  }
  try {
    return await emailGuestTakeaway(request, env);
  } catch (error) {
    if (error instanceof RangeError) return json({ ok: false, reason: "request_too_large" }, 413);
    if (error instanceof SyntaxError) return json({ ok: false, reason: "invalid_json" }, 400);
    throw error;
  }
}
