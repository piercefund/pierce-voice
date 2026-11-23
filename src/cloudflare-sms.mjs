import {
  isEmail,
  normalizePhoneNumber,
  normalizeSpokenEmail
} from "./cloudflare-booking.mjs";
import { handleEventRoute } from "./cloudflare-events.mjs";

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const EMAIL_ENTRY_EVENT_SLUG = "pierce-phone-career-check-in";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const HELP_MESSAGE =
  "PierceFund LLC: For help with your requested Pierce link, email voice@pierce.fund or call 1-866-967-2844. Msg & data rates may apply. Reply STOP to opt out.";
const STOP_MESSAGE =
  "PierceFund LLC: You have been unsubscribed and will receive no further text messages. Reply START to resubscribe.";
const START_MESSAGE =
  "PierceFund LLC: You are subscribed again. Messages are sent only when you request a one-time Pierce link. Reply HELP for help or STOP to opt out.";

export const EMAIL_ENTRY_CONSENT_SCRIPT =
  "PierceFund LLC can text one secure link to the mobile number you are calling from so you can enter and confirm your email. You will receive one message per request, not marketing or recurring messages. Message and data rates may apply. Reply HELP for help or STOP to opt out. Terms are available at pierce dot fund slash terms and our privacy policy is at pierce dot fund slash privacy. You can continue using Pierce without receiving a text. May I send this one-time text? Please say yes or no.";

export const EMAIL_ENTRY_SENT_CONFIRMATION =
  "Thank you. You have agreed to receive one transactional text from PierceFund LLC. I sent the secure link now. Open it to enter and confirm your email, and Pierce will send your recap after you submit it.";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    }
  });
}

function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlMessage(message = "") {
  return message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

async function readBoundedText(request, maxBytes = MAX_BODY_BYTES) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RangeError("Request body is too large.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new RangeError("Request body is too large.");
  }
  return body;
}

async function requestJson(request) {
  const raw = await readBoundedText(request);
  return raw ? JSON.parse(raw) : {};
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Bytes(value) {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function emailLinkStub(env, hash) {
  if (!env.EMAIL_LINKS) return null;
  return typeof env.EMAIL_LINKS.getByName === "function"
    ? env.EMAIL_LINKS.getByName(`email-link:${hash}`)
    : env.EMAIL_LINKS.get(env.EMAIL_LINKS.idFromName(`email-link:${hash}`));
}

async function stubForToken(env, token) {
  if (!TOKEN_PATTERN.test(String(token || ""))) return null;
  return emailLinkStub(env, await tokenHash(token));
}

function normalizedBaseUrl(env) {
  const configured = String(env.PIERCE_EMAIL_ENTRY_BASE_URL || "https://voice.pierce.fund").trim();
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function twilioConfigured(env) {
  const senderConfigured = env.TWILIO_MESSAGING_SERVICE_SID ||
    normalizePhoneNumber(env.TWILIO_FROM_NUMBER);
  return Boolean(
    env.EMAIL_LINKS &&
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    senderConfigured &&
    normalizedBaseUrl(env)
  );
}

async function sendTwilioMessage(env, to, body) {
  const accountSid = String(env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || "");
  const form = new URLSearchParams({ To: to, Body: body });
  if (env.TWILIO_MESSAGING_SERVICE_SID) {
    form.set("MessagingServiceSid", String(env.TWILIO_MESSAGING_SERVICE_SID).trim());
  } else {
    form.set("From", normalizePhoneNumber(env.TWILIO_FROM_NUMBER));
  }

  const apiBase = String(env.TWILIO_API_BASE || "https://api.twilio.com").replace(/\/$/, "");
  const response = await fetch(
    `${apiBase}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: form
    }
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) {
    const error = new Error("Twilio did not accept the message.");
    error.reason = "sms_delivery_rejected";
    error.status = response.status;
    error.providerCode = String(result.code || "");
    throw error;
  }
  return {
    sid: String(result.sid || ""),
    status: String(result.status || "queued")
  };
}

export async function createAndSendEmailEntryLink(env, { callerPhone, summary }) {
  if (!twilioConfigured(env)) {
    return { ok: false, reason: "sms_not_configured" };
  }
  const phone = normalizePhoneNumber(callerPhone);
  if (!phone) return { ok: false, reason: "caller_phone_unavailable" };

  const token = base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const hash = await tokenHash(token);
  const stub = emailLinkStub(env, hash);
  const createResponse = await stub.fetch(new Request("https://email-link.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token_hash: hash,
      phone,
      summary,
      expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString()
    })
  }));
  if (!createResponse.ok) {
    return { ok: false, reason: "email_link_creation_failed" };
  }

  const link = `${normalizedBaseUrl(env)}/email#${token}`;
  const message =
    `PierceFund LLC: Here is the secure Pierce link you requested to enter and confirm your email: ${link}. ` +
    "This is a one-time service message. Msg & data rates may apply. Reply HELP for help or STOP to opt out.";
  try {
    const sent = await sendTwilioMessage(env, phone, message);
    await stub.fetch(new Request("https://email-link.internal/sent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_sid: sent.sid, message_status: sent.status })
    }));
    return { ok: true, status: sent.status };
  } catch (error) {
    await stub.fetch(new Request("https://email-link.internal/revoke", { method: "POST" }));
    console.error(JSON.stringify({
      event: "phone_email_link_send_failed",
      reason: String(error?.reason || "sms_delivery_failed"),
      status: Number(error?.status || 0),
      provider_code: String(error?.providerCode || "")
    }));
    return { ok: false, reason: error?.reason || "sms_delivery_failed" };
  }
}

export async function validateTwilioSignature(request, rawBody, authToken) {
  const signature = String(request.headers.get("x-twilio-signature") || "");
  const signatureBytes = base64Bytes(signature);
  if (!signatureBytes?.length || !authToken) return false;

  const params = new URLSearchParams(rawBody);
  const names = [...new Set(params.keys())].sort();
  let signed = request.url;
  for (const name of names) {
    for (const value of params.getAll(name).sort()) signed += `${name}${value}`;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(signed)
  );
}

async function handleTwilioMessagingWebhook(request, env) {
  if (!env.TWILIO_AUTH_TOKEN) {
    return xml(twimlMessage(), 503);
  }
  let rawBody;
  try {
    rawBody = await readBoundedText(request);
  } catch (error) {
    return xml(twimlMessage(), error instanceof RangeError ? 413 : 400);
  }
  if (!await validateTwilioSignature(request, rawBody, env.TWILIO_AUTH_TOKEN)) {
    return xml(twimlMessage(), 403);
  }

  const form = new URLSearchParams(rawBody);
  const optOutType = String(form.get("OptOutType") || "").trim().toUpperCase();
  if (optOutType) {
    console.info(JSON.stringify({ event: "twilio_opt_out_event", opt_out_type: optOutType }));
    return xml(twimlMessage());
  }

  const keyword = String(form.get("Body") || "").trim().toUpperCase();
  if (keyword === "HELP" || keyword === "INFO") return xml(twimlMessage(HELP_MESSAGE));
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"].includes(keyword)) {
    return xml(twimlMessage(STOP_MESSAGE));
  }
  if (["START", "UNSTOP"].includes(keyword)) return xml(twimlMessage(START_MESSAGE));
  return xml(twimlMessage());
}

export async function handleSmsRoute(request, env) {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/webhooks/twilio/messaging") {
    return handleTwilioMessagingWebhook(request, env);
  }
  if (request.method === "POST" && url.pathname === "/email-link/status") {
    let body;
    try {
      body = await requestJson(request);
    } catch (error) {
      return json({ ok: false, reason: error instanceof RangeError ? "payload_too_large" : "invalid_json" },
        error instanceof RangeError ? 413 : 400);
    }
    const stub = await stubForToken(env, body.token);
    if (!stub) return json({ ok: false, reason: "invalid_or_expired_link" }, 404);
    const response = await stub.fetch(new Request("https://email-link.internal/status"));
    return new Response(response.body, { status: response.status, headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    } });
  }
  if (request.method === "POST" && url.pathname === "/email-link/complete") {
    let body;
    try {
      body = await requestJson(request);
    } catch (error) {
      return json({ ok: false, reason: error instanceof RangeError ? "payload_too_large" : "invalid_json" },
        error instanceof RangeError ? 413 : 400);
    }
    const stub = await stubForToken(env, body.token);
    if (!stub) return json({ ok: false, reason: "invalid_or_expired_link" }, 404);
    const response = await stub.fetch(new Request("https://email-link.internal/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guest_email: body.guest_email,
        email_confirmed: body.email_confirmed === true
      })
    }));
    return new Response(response.body, { status: response.status, headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    } });
  }
  return null;
}

export class PierceEmailLink {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/create") {
      return this.create(await request.json());
    }
    if (request.method === "POST" && url.pathname === "/sent") {
      return this.markSent(await request.json());
    }
    if (request.method === "POST" && url.pathname === "/revoke") {
      await this.ctx.storage.deleteAll();
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return this.status();
    }
    if (request.method === "POST" && url.pathname === "/complete") {
      return this.complete(await request.json());
    }
    return json({ ok: false, reason: "not_found" }, 404);
  }

  async create(body) {
    const phone = normalizePhoneNumber(body.phone);
    const expiresAt = Date.parse(body.expires_at);
    if (!body.token_hash || !phone || !body.summary || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return json({ ok: false, reason: "invalid_email_link_payload" }, 400);
    }
    const existing = await this.ctx.storage.get("email_link");
    if (existing) return json({ ok: false, reason: "email_link_already_exists" }, 409);
    await this.ctx.storage.put("email_link", {
      version: 1,
      status: "active",
      token_hash: String(body.token_hash),
      phone,
      summary: body.summary,
      created_at: new Date().toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      sms_sent_at: "",
      sms_status: ""
    });
    await this.ctx.storage.setAlarm(expiresAt + 5 * 60 * 1000);
    return json({ ok: true, expires_at: new Date(expiresAt).toISOString() });
  }

  async markSent(body) {
    const entry = await this.ctx.storage.get("email_link");
    if (!entry || entry.status !== "active") return json({ ok: false, reason: "email_link_not_active" }, 409);
    entry.sms_sent_at = new Date().toISOString();
    entry.sms_status = String(body.message_status || "queued");
    entry.message_sid = String(body.message_sid || "");
    await this.ctx.storage.put("email_link", entry);
    return json({ ok: true });
  }

  async status() {
    const entry = await this.ctx.storage.get("email_link");
    if (!entry || entry.status === "used") {
      return json({ ok: false, reason: "invalid_or_expired_link" }, 404);
    }
    if (Date.parse(entry.expires_at) <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return json({ ok: false, reason: "invalid_or_expired_link" }, 404);
    }
    if (entry.status !== "active") return json({ ok: false, reason: "link_is_being_processed" }, 409);
    return json({ ok: true, expires_at: entry.expires_at });
  }

  async complete(body) {
    const entry = await this.ctx.storage.get("email_link");
    if (!entry || entry.status === "used" || Date.parse(entry.expires_at) <= Date.now()) {
      if (entry && Date.parse(entry.expires_at) <= Date.now()) await this.ctx.storage.deleteAll();
      return json({ ok: false, reason: "invalid_or_expired_link" }, 404);
    }
    if (entry.status !== "active") return json({ ok: false, reason: "link_is_being_processed" }, 409);

    const email = normalizeSpokenEmail(body.guest_email);
    if (!isEmail(email) || body.email_confirmed !== true) {
      return json({ ok: false, reason: "email_not_confirmed" }, 400);
    }

    entry.status = "processing";
    entry.processing_at = new Date().toISOString();
    await this.ctx.storage.put("email_link", entry);
    let response;
    try {
      response = await handleEventRoute(new Request("https://email-link.internal/event/quick-start/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_slug: EMAIL_ENTRY_EVENT_SLUG,
          ...entry.summary,
          phone: entry.phone,
          guest_email: email,
          email_confirmed: true,
          email_consent: true,
          source_id: `email-link:${entry.token_hash}`
        })
      }), this.env);
    } catch (error) {
      entry.status = "active";
      delete entry.processing_at;
      await this.ctx.storage.put("email_link", entry);
      throw error;
    }
    const result = response ? await response.json() : { ok: false, reason: "route_not_found" };
    if (!response?.ok || result.ok !== true) {
      entry.status = "active";
      delete entry.processing_at;
      await this.ctx.storage.put("email_link", entry);
      return json({ ok: false, reason: result.reason || "email_delivery_failed" }, response?.status || 503);
    }

    await this.ctx.storage.put("email_link", {
      version: 1,
      status: "used",
      used_at: new Date().toISOString(),
      expires_at: entry.expires_at
    });
    return json({
      ok: true,
      email_status: result.email_status,
      message: result.email_status === "sent"
        ? "Your email is confirmed and your recap was sent."
        : "Your email is confirmed and your recap is queued for delivery."
    });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
