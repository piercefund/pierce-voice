const tokenCache = new Map();

export class GoogleApiError extends Error {
  constructor(reason, message, status = 502) {
    super(message);
    this.name = "GoogleApiError";
    this.reason = reason;
    this.status = status;
  }
}

export function googleConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALENDAR_REFRESH_TOKEN);
}

async function accessToken(env, force = false) {
  if (!googleConfigured(env)) {
    throw new GoogleApiError("google_not_connected", "Google Calendar and Gmail are not connected.", 503);
  }
  const cacheKey = env.GOOGLE_CLIENT_ID;
  const cached = tokenCache.get(cacheKey);
  if (!force && cached?.expiresAt > Date.now() + 60000) return cached.token;
  const response = await fetch(env.GOOGLE_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_CALENDAR_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new GoogleApiError("google_auth_failed", body.error_description || body.error || `Google OAuth returned ${response.status}.`, response.status || 502);
  }
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 });
  return body.access_token;
}

async function googleRequest(env, base, path, options = {}, retry = true) {
  const token = await accessToken(env);
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers }
  });
  if (response.status === 401 && retry) {
    tokenCache.delete(env.GOOGLE_CLIENT_ID);
    await accessToken(env, true);
    return googleRequest(env, base, path, options, false);
  }
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GoogleApiError(response.status === 409 ? "google_calendar_duplicate" : "google_api_failed",
      body.error?.message || `Google returned ${response.status}.`, response.status);
  }
  return body;
}

function pacificOffset(dateString) {
  const value = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" })
    .formatToParts(new Date(`${dateString}T12:00:00Z`)).find((part) => part.type === "timeZoneName")?.value;
  const match = value?.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  const hours = Number(match?.[1]);
  return `${hours < 0 ? "-" : "+"}${String(Math.abs(hours)).padStart(2, "0")}:${match?.[2] || "00"}`;
}

function instant(date, time) {
  return new Date(`${date}T${time}${pacificOffset(date)}`);
}

async function eventId(requestId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId));
  return `pierce${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
}

function confirmation(requestId) {
  return `PIERCE-${requestId.replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase()}`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export async function createCalendarBooking(env, booking) {
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";
  const base = env.GOOGLE_CALENDAR_API_BASE || "https://www.googleapis.com/calendar/v3";
  const availability = await googleRequest(env, base, "/freeBusy", { method: "POST", body: JSON.stringify({
    timeMin: instant(booking.date, booking.time).toISOString(),
    timeMax: instant(booking.end_date, booking.end_time).toISOString(),
    timeZone: booking.timezone,
    items: [{ id: calendarId }]
  }) });
  const calendar = availability.calendars?.[calendarId] || Object.values(availability.calendars || {})[0];
  if (calendar?.errors?.length) throw new GoogleApiError("google_calendar_availability_failed", "Google could not check calendar availability.");
  if ((calendar?.busy || []).length) return { available: false };

  const id = await eventId(booking.request_id);
  const code = confirmation(booking.request_id);
  const checkInUrl = env.PIERCE_CHECK_IN_URL || "https://pierce-voice-cloudflare-staging.piercefund.workers.dev/check-in";
  const event = {
    id,
    summary: `${booking.guest.name} with Pierce`,
    description: `<p><strong>15-minute session with Pierce</strong></p><p><strong>Reason</strong><br>${escapeHtml(booking.guest.topic)}</p><p><strong>Confirmation</strong><br>${escapeHtml(code)}</p><h2>Check in at your appointment time</h2><p><a href="${escapeHtml(checkInUrl)}"><strong>Check in with Pierce</strong></a></p>`,
    start: { dateTime: `${booking.date}T${booking.time}${pacificOffset(booking.date)}`, timeZone: booking.timezone },
    end: { dateTime: `${booking.end_date}T${booking.end_time}${pacificOffset(booking.end_date)}`, timeZone: booking.timezone },
    attendees: [{ email: booking.guest.email, displayName: booking.guest.name, responseStatus: "needsAction" }],
    guestsCanInviteOthers: false, guestsCanModify: false, reminders: { useDefault: true }, transparency: "opaque",
    extendedProperties: { private: { pierceBookingRequestId: booking.request_id, pierceConfirmation: code } }
  };
  let created;
  try {
    created = await googleRequest(env, base, `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all&conferenceDataVersion=0`, { method: "POST", body: JSON.stringify(event) });
  } catch (error) {
    if (error.reason !== "google_calendar_duplicate") throw error;
    created = await googleRequest(env, base, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`);
    if (created.extendedProperties?.private?.pierceBookingRequestId !== booking.request_id) throw error;
  }
  return { available: true, event_id: created.id || id, event_url: created.htmlLink || "", confirmation: code, invite_sent: true };
}

export async function createMentorCalendarBooking(env, booking) {
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";
  const base = env.GOOGLE_CALENDAR_API_BASE || "https://www.googleapis.com/calendar/v3";
  const id = await eventId(booking.booking_id);
  const eventUrl = `${env.PIERCE_PUBLIC_BASE_URL || "https://pierce-voice-cloudflare-staging.piercefund.workers.dev"}/events/${booking.event_slug}`;
  const startupWeekGuideUrl = `${env.PIERCE_PUBLIC_BASE_URL || "https://pierce-voice-cloudflare-staging.piercefund.workers.dev"}/events/san-diego-startup-week-guide`;
  const event = {
    id,
    summary: `${booking.participant.name} with ${booking.mentor_name}`,
    description: `<p><strong>San Diego Startup Week Mentoring</strong></p><p>30-minute small-group mentoring session at ${escapeHtml(booking.location)} with ${escapeHtml(booking.mentor_name)}.</p><p><strong>Biggest challenge</strong><br>${escapeHtml(booking.biggest_challenge)}</p><p><strong>Booking ID</strong><br>${escapeHtml(booking.booking_id)}</p><p><a href="${escapeHtml(eventUrl)}">View, reschedule, or cancel the appointment</a></p><p><strong>Explore Startup Week</strong><br><a href="${escapeHtml(startupWeekGuideUrl)}">Open the Startup Week Guide</a></p>`,
    location: `Pure Project Carlsbad · ${booking.location}`,
    start: { dateTime: `${booking.date}T${booking.start_time}:00${pacificOffset(booking.date)}`, timeZone: booking.timezone },
    end: { dateTime: `${booking.date}T${booking.end_time}:00${pacificOffset(booking.date)}`, timeZone: booking.timezone },
    attendees: [
      { email: booking.participant.email, displayName: booking.participant.name, responseStatus: "needsAction" },
      { email: booking.notification_email || booking.mentor_email, displayName: "Pierce event team", responseStatus: "needsAction" }
    ],
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    reminders: { useDefault: true },
    transparency: "opaque",
    extendedProperties: { private: { pierceMentorBookingId: booking.booking_id, pierceEventSlug: booking.event_slug } }
  };
  let created;
  try {
    created = await googleRequest(env, base,
      `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all&conferenceDataVersion=0`,
      { method: "POST", body: JSON.stringify(event) });
  } catch (error) {
    if (error.reason !== "google_calendar_duplicate") throw error;
    created = await googleRequest(env, base,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`);
    if (created.extendedProperties?.private?.pierceMentorBookingId !== booking.booking_id) throw error;
  }
  return { event_id: created.id || id, event_url: created.htmlLink || "", invite_sent: true };
}

export async function sendMentorBookingConfirmation(env, booking) {
  const publicBaseUrl = env.PIERCE_PUBLIC_BASE_URL ||
    "https://pierce-voice-cloudflare-staging.piercefund.workers.dev";
  const participantUrl = `${publicBaseUrl}/mentor`;
  const startupWeekGuideUrl = `${publicBaseUrl}/events/san-diego-startup-week-guide`;
  const startLabel = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: booking.timezone
  }).format(instant(booking.date, booking.start_time));
  return sendGmail(env, {
    to: booking.participant.email,
    subject: `Your Startup Week mentoring session at ${startLabel}`,
    body: [
      `Hi ${booking.participant.name},`,
      "",
      "Your San Diego Startup Week mentoring session is booked.",
      "",
      `Time: ${startLabel}`,
      `Table: ${booking.location}`,
      `Mentor: ${booking.mentor_name}`,
      `Booking ID: ${booking.booking_id}`,
      "",
      `View, reschedule, cancel, or check in: ${participantUrl}`,
      "",
      "Explore events selected for your goals with the Startup Week Guide:",
      startupWeekGuideUrl
    ].join("\n")
  });
}

export async function cancelCalendarBooking(env, eventId) {
  if (!eventId) return { cancelled: false };
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";
  const base = env.GOOGLE_CALENDAR_API_BASE || "https://www.googleapis.com/calendar/v3";
  await googleRequest(env, base, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" });
  return { cancelled: true };
}

function base64UrlUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sendGmail(env, { to, subject, body, html }) {
  const sender = env.GOOGLE_CALENDAR_ACCOUNT_EMAIL || "voice@pierce.fund";
  const clean = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();
  const headers = [`From: Pierce <${clean(sender)}>`, `To: ${clean(to)}`, `Subject: ${clean(subject)}`, "MIME-Version: 1.0"];
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", String(body || "")];
  let message = textPart;
  if (html) {
    const boundary = `pierce-${crypto.randomUUID()}`;
    message = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
      `--${boundary}`, ...textPart,
      `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", html,
      `--${boundary}--`
    ];
  }
  const raw = base64UrlUtf8([...headers, ...message].join("\r\n"));
  return googleRequest(env, env.GOOGLE_GMAIL_API_BASE || "https://gmail.googleapis.com/gmail/v1", "/users/me/messages/send",
    { method: "POST", body: JSON.stringify({ raw }) });
}
