import { cancelCalendarBooking, createCalendarBooking, GoogleApiError, googleConfigured, sendGmail } from "./cloudflare-google-api.mjs";
import { queueHubspotSync } from "./cloudflare-hubspot.mjs";

const OWNER_TIMEZONE = "America/Los_Angeles";
const SESSION_MINUTES = 15;
const BOOKING_KEY = "pierce-data/booking-requests.jsonl";
const CHECK_IN_KEY = "pierce-data/check-in-requests.jsonl";
const MAX_JSON_BYTES = 64 * 1024;

function json(body, status = 200) {
  return Response.json(body, { status });
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

function normalizeTime(time) {
  const value = String(time || "").trim();
  const match12 = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (match12) {
    let hour = Number(match12[1]);
    const minute = Number(match12[2] || "0");
    if (minute > 59 || hour < 1 || hour > 12) return value;
    const meridiem = match12[3].toUpperCase();
    if (meridiem === "PM" && hour !== 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  }

  const match24 = value.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match24) return value;
  return `${String(Number(match24[1])).padStart(2, "0")}:${match24[2]}:${match24[3] || "00"}`;
}

function formatTime12Hour(time) {
  const match = String(time || "").match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) return String(time || "");
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

function bookingConfirmationEmail(env, booking, calendar) {
  const firstName = booking.guest.name.split(/\s+/)[0] || booking.guest.name;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(new Date(`${booking.date}T12:00:00Z`));
  const checkInUrl = env.PIERCE_CHECK_IN_URL || "https://pierce-voice-cloudflare-staging.piercefund.workers.dev/check-in";
  return {
    to: booking.guest.email,
    subject: `Your Pierce session is booked for ${booking.date}`,
    body: [
      `Hi ${firstName},`,
      "",
      "Your 15-minute session with Pierce is booked.",
      "",
      `Date: ${date}`,
      `Time: ${formatTime12Hour(booking.time)} Pacific Time`,
      `Reason: ${booking.guest.topic}`,
      `Confirmation: ${calendar.confirmation}`,
      "",
      "You are also listed as a guest on the Google Calendar event.",
      `Check in at your appointment time: ${checkInUrl}`,
      "",
      "Pierce"
    ].join("\n")
  };
}

export function normalizeSpokenEmail(email) {
  let normalized = String(email || "")
    .trim()
    .toLowerCase()
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+/g, "");
  const commonProviderDomains = {
    gmail: "gmail.com",
    googlemail: "googlemail.com",
    yahoo: "yahoo.com",
    yahoomail: "yahoo.com",
    hotmail: "hotmail.com",
    outlook: "outlook.com",
    aol: "aol.com",
    icloud: "icloud.com",
    live: "live.com",
    msn: "msn.com",
    protonmail: "protonmail.com"
  };
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex > 0) {
    const provider = normalized.slice(atIndex + 1);
    if (commonProviderDomains[provider]) {
      normalized = `${normalized.slice(0, atIndex + 1)}${commonProviderDomains[provider]}`;
    }
  }
  const corrections = {
    "curling@focus.com": "kurling@fokcus.com",
    "kurling@focus.com": "kurling@fokcus.com",
    "curling@fokcus.com": "kurling@fokcus.com"
  };
  return corrections[normalized] || normalized;
}

export function normalizePhoneNumber(phone) {
  const value = String(phone || "").trim();
  const sipAddress = value.match(/sip:\s*([^@;>\s]+)/i)?.[1] || value;
  const digits = sipAddress.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}

export function emailIdentityKey(email) {
  const normalized = normalizeSpokenEmail(email);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex === -1) return normalized;
  let local = normalized.slice(0, atIndex);
  let domain = normalized.slice(atIndex + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.split("+")[0].replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

function emailSpokenReadback(email) {
  const words = { ".": "dot", "-": "dash", "_": "underscore", "+": "plus" };
  const speak = (part) => [...part].map((character) => words[character] || character).join(" ");
  const [local, domain] = String(email || "").split("@");
  return `${speak(local)} at ${speak(domain)}`;
}

export function normalizeGuestName(name) {
  const value = String(name || "").trim();
  const corrections = {
    "curling robinson": "Kurling Robinson",
    "curlan robinson": "Kurling Robinson",
    "natasha duttal": "Natasha Dhital",
    "natasha dutal": "Natasha Dhital"
  };
  return corrections[value.toLowerCase()] || value;
}

export function nameKey(name) {
  return normalizeGuestName(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function pacificOffset(dateString) {
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TIMEZONE,
    timeZoneName: "shortOffset"
  }).formatToParts(new Date(`${dateString}T12:00:00Z`)).find((part) => part.type === "timeZoneName")?.value;
  const match = offsetName?.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!match) throw new Error(`Unable to determine Pacific offset for ${dateString}`);
  const hours = Number(match[1]);
  return `${hours < 0 ? "-" : "+"}${String(Math.abs(hours)).padStart(2, "0")}:${match[2] || "00"}`;
}

function localDateTimeToInstant(date, time) {
  return new Date(`${date}T${time}${pacificOffset(date)}`);
}

function addMinutesLocal(dateString, timeString, minutes) {
  const date = new Date(`${dateString}T${timeString}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return { date: date.toISOString().slice(0, 10), time: date.toISOString().slice(11, 19) };
}

export function todayInPacific() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: OWNER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nowInPacific() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date());
}

export function recordId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function parseJsonLines(text) {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function readObject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return { rows: [], text: "", etag: null };
  const text = await object.text();
  return { rows: parseJsonLines(text), text, etag: object.etag };
}

export async function mutateJsonLines(bucket, key, buildRecord) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readObject(bucket, key);
    const record = await buildRecord(current.rows);
    if (record instanceof Response) return record;

    const onlyIf = current.etag
      ? { etagMatches: current.etag }
      : { etagDoesNotMatch: "*" };
    const written = await bucket.put(key, `${current.text}${JSON.stringify(record)}\n`, {
      onlyIf,
      httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" }
    });
    if (written) return record;
  }
  throw new Error(`Concurrent update limit exceeded for ${key}`);
}

function isBookingRecord(row) {
  return row.check_in !== true && row.queue_type !== "booking_change" && row.guest?.email;
}

function cancelledBookingIds(rows) {
  return new Set(rows.filter((row) => row.queue_type === "booking_change" && row.action === "cancel_booking")
    .filter((row) => !String(row.status || "").startsWith("failed"))
    .map((row) => row.target_booking_request_id));
}

export function uncancelledBookingRows(rows) {
  const cancelled = cancelledBookingIds(rows);
  return rows.filter(isBookingRecord).filter((row) => !cancelled.has(row.request_id));
}

function activeBookingRows(rows) {
  const cancelled = cancelledBookingIds(rows);
  return rows.filter(isBookingRecord).filter((row) => !cancelled.has(row.request_id)).filter((row) => {
    try {
      return localDateTimeToInstant(row.end_date || row.date, row.end_time || row.time).getTime() > Date.now();
    } catch {
      return false;
    }
  }).sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

export function bookingSummary(row) {
  return {
    booking_request_id: row.request_id,
    guest_name: row.guest.name,
    guest_email: row.guest.email,
    date: row.date,
    time: formatTime12Hour(row.time),
    end_time: formatTime12Hour(row.end_time),
    topic: row.guest.topic,
    status: row.status,
    confirmation: row.confirmation || "",
    event_id: row.event_id || ""
  };
}

export async function findActiveBookingsByPhone(bucket, phone) {
  const phoneKey = normalizePhoneNumber(phone);
  if (!bucket || !phoneKey) return [];
  const { rows } = await readObject(bucket, BOOKING_KEY);
  return activeBookingRows(rows)
    .filter((row) => normalizePhoneNumber(row.guest?.phone) === phoneKey)
    .slice(0, 2)
    .map((row) => {
      const { guest_email: _email, ...summary } = bookingSummary(row);
      return summary;
    });
}

async function verifyEmail(request) {
  const body = await requestJson(request);
  const email = normalizeSpokenEmail(body.guest_email);
  if (!isEmail(email)) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const reason = email.includes("@") && domain && !domain.includes(".")
      ? "missing_domain_ending"
      : "invalid_email";
    return json({ ok: false, reason, captured_email: String(body.guest_email || "").trim() }, 400);
  }
  return json({ ok: true, guest_email: email, spoken_readback: emailSpokenReadback(email) });
}

async function existingBookings(request, env) {
  const body = await requestJson(request);
  const email = normalizeSpokenEmail(body.guest_email);
  if (!isEmail(email) || body.email_confirmed !== true) return json({ ok: false, reason: "email_not_confirmed" }, 400);
  const { rows } = await readObject(env.PIERCE_DATA, BOOKING_KEY);
  const matches = activeBookingRows(rows).filter((row) => emailIdentityKey(row.guest.email) === emailIdentityKey(email)).map(bookingSummary);
  return json({ ok: true, guest_email: email, match_count: matches.length, matches });
}

async function createBooking(request, env) {
  const body = await requestJson(request);
  const quietMode = body.interaction_mode === "quiet";
  const guest = {
    name: normalizeGuestName(body.guest_name),
    email: normalizeSpokenEmail(body.guest_email),
    topic: String(body.topic || "").trim(),
    phone: normalizePhoneNumber(body.phone)
  };
  const date = String(body.date || "").trim();
  const time = normalizeTime(body.time);
  if (!guest.name || !guest.email || !guest.topic || !date || !time ||
      (!quietMode && body.recording_consent !== true)) {
    return json({ ok: false, reason: "missing_required_fields" }, 400);
  }
  if (body.email_confirmed !== true) return json({ ok: false, reason: "email_not_confirmed" }, 400);
  if (!isEmail(guest.email)) return json({ ok: false, reason: "invalid_email", captured_email: body.guest_email }, 400);
  if (localDateTimeToInstant(date, time).getTime() <= Date.now()) return json({ ok: false, reason: "past_time" }, 400);

  const end = addMinutesLocal(date, time, SESSION_MINUTES);
  const { rows: existingRows } = await readObject(env.PIERCE_DATA, BOOKING_KEY);
  const existingMatches = activeBookingRows(existingRows).filter((row) => emailIdentityKey(row.guest.email) === emailIdentityKey(guest.email));
  if (existingMatches.length) return json({ ok: false, reason: "existing_booking", match_count: existingMatches.length, matches: existingMatches.map(bookingSummary) }, 409);
  const requestId = recordId("REQ");
  const draft = {
    request_id: requestId,
    guest,
    date,
    time,
    end_date: end.date,
    end_time: end.time,
    timezone: OWNER_TIMEZONE
  };
  let calendar = null;
  if (googleConfigured(env)) {
    try {
      calendar = await createCalendarBooking(env, draft);
    } catch (error) {
      if (error instanceof GoogleApiError) return json({ ok: false, reason: error.reason }, error.status);
      throw error;
    }
    if (!calendar.available) return json({ ok: false, reason: "time_unavailable", date, time }, 409);
  }
  let confirmationEmail = null;
  if (calendar) {
    try {
      const sent = await sendGmail(env, bookingConfirmationEmail(env, draft, calendar));
      confirmationEmail = { sent: true, message_id: sent.id || "", error: "" };
    } catch (error) {
      confirmationEmail = { sent: false, message_id: "", error: error instanceof GoogleApiError ? error.reason : "confirmation_email_failed" };
    }
  }
  const created = await mutateJsonLines(env.PIERCE_DATA, BOOKING_KEY, (rows) => {
    const matches = activeBookingRows(rows).filter((row) => emailIdentityKey(row.guest.email) === emailIdentityKey(guest.email));
    if (matches.length) return json({ ok: false, reason: "existing_booking", match_count: matches.length, matches: matches.map(bookingSummary) }, 409);
    return {
      request_id: requestId,
      created_at: new Date().toISOString(),
      queue_type: "booking",
      check_in: false,
      status: calendar ? "booked_google_calendar" : "cloudflare_staging_saved",
      calendar_id: "primary",
      owner_email: "voice@pierce.fund",
      guest,
      date,
      time,
      end_date: end.date,
      end_time: end.time,
      duration_minutes: SESSION_MINUTES,
      timezone: OWNER_TIMEZONE,
      interaction_mode: quietMode ? "quiet" : "voice",
      recording_consent: quietMode ? false : true,
      email_confirmed: true,
      event_id: calendar?.event_id || "",
      event_url: calendar?.event_url || "",
      confirmation: calendar?.confirmation || "",
      invite_sent: calendar?.invite_sent === true,
      confirmation_email_sent: confirmationEmail?.sent === true,
      confirmation_email_message_id: confirmationEmail?.message_id || "",
      confirmation_email_error: confirmationEmail?.error || "",
      replaces_booking_request_id: String(body.replaces_booking_request_id || "").trim()
    };
  });
  if (created instanceof Response) return created;
  const hubspotSync = await queueHubspotSync(env, "booking", created);
  return json({
    ok: true,
    booked: Boolean(calendar),
    invite_sent: calendar?.invite_sent === true,
    confirmation_email_sent: confirmationEmail?.sent === true,
    confirmation_email_error: confirmationEmail?.error || "",
    queued: !calendar,
    request_id: created.request_id,
    queue_type: created.queue_type,
    check_in: false,
    status: created.status,
    calendar_id: created.calendar_id,
    owner_email: created.owner_email,
    date,
    time,
    end_date: end.date,
    end_time: end.time,
    duration_minutes: SESSION_MINUTES,
    guest_email: guest.email,
    guest_name: guest.name,
    confirmation: calendar?.confirmation || "",
    event_id: calendar?.event_id || "",
    event_url: calendar?.event_url || "",
    hubspot_sync: hubspotSync,
    replaces_booking_request_id: created.replaces_booking_request_id
  });
}

async function cancelBooking(request, env) {
  const body = await requestJson(request);
  const email = normalizeSpokenEmail(body.guest_email);
  const bookingRequestId = String(body.booking_request_id || "").trim();
  if (!isEmail(email) || !bookingRequestId || body.cancellation_confirmed !== true) return json({ ok: false, reason: "cancellation_not_confirmed" }, 400);
  const { rows: currentRows } = await readObject(env.PIERCE_DATA, BOOKING_KEY);
  const currentBooking = activeBookingRows(currentRows).find((row) => row.request_id === bookingRequestId && emailIdentityKey(row.guest.email) === emailIdentityKey(email));
  if (!currentBooking) return json({ ok: false, reason: "active_booking_not_found" }, 404);
  if (googleConfigured(env) && currentBooking.event_id) {
    try {
      await cancelCalendarBooking(env, currentBooking.event_id);
    } catch (error) {
      if (error instanceof GoogleApiError) return json({ ok: false, reason: error.reason }, error.status);
      throw error;
    }
  }
  const cancellation = await mutateJsonLines(env.PIERCE_DATA, BOOKING_KEY, (rows) => {
    const booking = activeBookingRows(rows).find((row) => row.request_id === bookingRequestId && emailIdentityKey(row.guest.email) === emailIdentityKey(email));
    if (!booking) return json({ ok: false, reason: "active_booking_not_found" }, 404);
    return {
      request_id: recordId("CAN"),
      created_at: new Date().toISOString(),
      queue_type: "booking_change",
      check_in: false,
      action: "cancel_booking",
      status: "cloudflare_staging_saved",
      target_booking_request_id: booking.request_id,
      guest: { name: booking.guest.name, email },
      date: booking.date,
      time: booking.time,
      topic: booking.guest.topic,
      timezone: OWNER_TIMEZONE,
      replacement_requested: body.replacement_requested === true,
      cancellation_confirmed: true
    };
  });
  if (cancellation instanceof Response) return cancellation;
  return json({ ok: true, request_id: cancellation.request_id, action: cancellation.action, status: cancellation.status, booking_request_id: cancellation.target_booking_request_id, date: cancellation.date, time: cancellation.time, topic: cancellation.topic, replacement_requested: cancellation.replacement_requested });
}

async function lookupCheckIn(request, env) {
  const body = await requestJson(request);
  const guestName = normalizeGuestName(body.guest_name);
  const guestIdentity = nameKey(guestName);
  const targetDate = String(body.date || todayInPacific()).trim();
  if (!guestIdentity) return json({ ok: false, reason: "missing_guest_name" }, 400);
  const { rows } = await readObject(env.PIERCE_DATA, BOOKING_KEY);
  const matches = activeBookingRows(rows).filter((row) => {
    const candidate = nameKey(row.guest.name);
    return candidate === guestIdentity || candidate.includes(guestIdentity) || guestIdentity.includes(candidate);
  }).sort((a, b) => {
    const dateOrder = Number(a.date !== targetDate) - Number(b.date !== targetDate);
    return dateOrder || `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`);
  }).slice(0, 4).map((row) => ({ booking_request_id: row.request_id, guest_name: row.guest.name, date: row.date, time: formatTime12Hour(row.time), end_time: formatTime12Hour(row.end_time), topic: row.guest.topic, status: row.status, confirmation: row.confirmation || "", meet_link: "" }));
  return json({ ok: true, guest_name: guestName, date: targetDate, match_count: matches.length, matches });
}

async function createCheckIn(request, env) {
  const body = await requestJson(request);
  const quietMode = body.interaction_mode === "quiet";
  const guestName = normalizeGuestName(body.guest_name);
  if (!guestName || (!quietMode && body.recording_consent !== true)) {
    return json({ ok: false, reason: "missing_required_fields" }, 400);
  }
  const record = {
    request_id: recordId("CHK"),
    created_at: new Date().toISOString(),
    queue_type: "check_in",
    check_in: true,
    status: "cloudflare_staging_saved",
    action: "mark_guest_checked_in",
    calendar_id: "primary",
    owner_email: "voice@pierce.fund",
    guest: { name: guestName },
    date: String(body.date || todayInPacific()).trim(),
    session_time: normalizeTime(body.session_time) || "",
    booking_request_id: String(body.booking_request_id || "").trim(),
    topic: String(body.topic || "").trim(),
    timezone: OWNER_TIMEZONE,
    interaction_mode: quietMode ? "quiet" : "voice",
    recording_consent: quietMode ? false : true,
    admin_calendar_note: `Admin note: Guest checked in at ${nowInPacific()}.`
  };
  await mutateJsonLines(env.PIERCE_DATA, CHECK_IN_KEY, () => record);
  return json({ ok: true, request_id: record.request_id, queue_type: record.queue_type, check_in: true, status: record.status, action: record.action, calendar_id: record.calendar_id, owner_email: record.owner_email, guest_name: guestName, date: record.date, session_time: record.session_time, booking_request_id: record.booking_request_id, topic: record.topic, timezone: record.timezone, admin_calendar_note: record.admin_calendar_note });
}

export async function handleBookingRoute(request, env) {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return null;
  if (path === "/booking/email/verify") return verifyEmail(request);
  const persistentRoutes = new Set([
    "/booking/existing",
    "/booking/request",
    "/booking/cancel",
    "/check-in/lookup",
    "/check-in/request"
  ]);
  if (!persistentRoutes.has(path)) return null;
  if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
  if (path === "/booking/existing") return existingBookings(request, env);
  if (path === "/booking/request") return createBooking(request, env);
  if (path === "/booking/cancel") return cancelBooking(request, env);
  if (path === "/check-in/lookup") return lookupCheckIn(request, env);
  if (path === "/check-in/request") return createCheckIn(request, env);
  return null;
}
