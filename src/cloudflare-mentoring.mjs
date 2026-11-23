import {
  emailIdentityKey,
  isEmail,
  mutateJsonLines,
  normalizeGuestName,
  normalizeSpokenEmail,
  readObject,
  recordId
} from "./cloudflare-booking.mjs";
import {
  cancelCalendarBooking,
  createMentorCalendarBooking,
  googleConfigured,
  sendMentorBookingConfirmation
} from "./cloudflare-google-api.mjs";

const STARTUP_WEEK_SLUG = "san-diego-startup-week-mentoring";
const MENTOR_BOOKINGS_KEY = "pierce-data/event-mentor-bookings.jsonl";
const MENTOR_ROSTER_KEY = "pierce-data/event-mentor-roster.json";
const EVENT_DATE = "2026-11-02";
const TIMEZONE = "America/Los_Angeles";
const START_TIMES = ["13:00", "13:30", "14:00"];
const SESSION_MINUTES = 30;
const FOUNDER_CAPACITY = 3;
const MAX_JSON_BYTES = 32 * 1024;
const DEFAULT_MENTOR_NAMES = [
  "Eric Bolt",
  "Paola Ometto",
  "Steve Sivitz",
  "Julius Alejandro",
  "Alex Waters",
  "Berit Anderson",
  "Diana Barbiani",
  "Joel Sedeno",
  "Miguel Magdaleno",
  "Pam Covarrubias",
  "Sara Nicholson",
  "Shawn Lynam"
];
const EXPERTISE_CATEGORIES = new Set([
  "Product", "Engineering", "Design", "Marketing", "Fundraising", "Operations", "Growth", "Legal",
  "Other", "Artificial Intelligence", "Machine Learning", "Product Development", "Data Science", "FinTech",
  "Analytics", "Sustainability", "Environmental Policy", "Nonprofits", "Healthcare Technology",
  "Software Engineering", "Leadership", "EdTech", "Entrepreneurship", "Digital Learning", "Blockchain",
  "Cryptography", "Startups", "Media", "Content Creation", "Digital Marketing", "Cybersecurity",
  "Risk Management", "IT Governance", "Clinical Research", "Healthcare", "Biotech", "Urban Planning",
  "Architecture", "Smart Cities", "Retail", "E-commerce", "Agriculture", "AgriTech", "UX/UI",
  "Creative Direction", "Law", "Compliance", "Corporate Governance", "Social Impact", "Technology for Good"
]);

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

function defaultMentorRoster() {
  return DEFAULT_MENTOR_NAMES.map((name, index) => ({ name, expertise: [], table: index + 1 }));
}

function normalizeExpertise(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  return [...new Set(values.map((item) => String(item).trim()).filter((item) => EXPERTISE_CATEGORIES.has(item)))];
}

function normalizeMentorRoster(value) {
  if (!Array.isArray(value)) return null;
  const roster = value.map((entry) => ({
    name: normalizeGuestName(entry?.name),
    expertise: normalizeExpertise(entry?.expertise),
    table: Number(entry?.table)
  })).filter((entry) => entry.name && Number.isInteger(entry.table) && entry.table >= 1 && entry.table <= 30);
  const tableCounts = roster.reduce((counts, entry) =>
    counts.set(entry.table, (counts.get(entry.table) || 0) + 1), new Map());
  if ([...tableCounts.values()].some((count) => count > 4)) return null;
  return roster.length === value.length && roster.length ? roster.sort((a, b) => a.table - b.table) : null;
}

function publicParticipantName(value) {
  const parts = normalizeGuestName(value).split(/\s+/).filter(Boolean);
  if (!parts.length) return "Participant";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)[0]}.`;
}

async function mentorRoster(env) {
  const object = await env.PIERCE_DATA.get(MENTOR_ROSTER_KEY);
  if (!object) return defaultMentorRoster();
  const stored = await object.text().then((text) => JSON.parse(text)).catch(() => null);
  return normalizeMentorRoster(stored?.mentors) || defaultMentorRoster();
}

export async function mentoringSchedule(env) {
  const roster = await mentorRoster(env);
  const grouped = new Map();
  for (const { name, expertise, table } of roster) {
    if (!grouped.has(table)) grouped.set(table, []);
    grouped.get(table).push({ name, expertise });
  }
  const mentors = [...grouped].map(([table, assignments]) => ({
    id: `mentor-${table}`,
    name: assignments.length === 1
      ? assignments[0].name
      : `${assignments.slice(0, -1).map((mentor) => mentor.name).join(", ")} and ${assignments.at(-1).name}`,
    names: assignments.map((mentor) => mentor.name),
    expertise: [...new Set(assignments.flatMap((mentor) => mentor.expertise))],
    table,
    location: `Table ${table}`,
    email_configured: true
  }));
  return {
    event_slug: STARTUP_WEEK_SLUG,
    date: EVENT_DATE,
    date_label: "November 2, 2026",
    timezone: TIMEZONE,
    session_minutes: SESSION_MINUTES,
    founder_capacity: FOUNDER_CAPACITY,
    start_times: [...START_TIMES],
    mentors
  };
}

async function mentorFor(env, mentorId) {
  const schedule = await mentoringSchedule(env);
  const mentor = schedule.mentors.find((candidate) => candidate.id === mentorId);
  if (!mentor) return null;
  return {
    ...mentor,
    email: normalizeSpokenEmail(env.PIERCE_MENTOR_NOTIFICATION_EMAIL ||
      env.GOOGLE_CALENDAR_ACCOUNT_EMAIL || "voice@pierce.fund")
  };
}

function addMinutes(time, minutes) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function bookingState(rows) {
  const state = new Map();
  for (const row of rows) {
    if (row.record_type === "booking") state.set(row.booking_id, { ...row });
    if (row.record_type === "booking_calendar" && state.has(row.booking_id)) {
      Object.assign(state.get(row.booking_id), row);
    }
    if (row.record_type === "check_in" && state.has(row.booking_id)) {
      Object.assign(state.get(row.booking_id), { checked_in_at: row.checked_in_at });
    }
    if (["cancellation", "calendar_failure"].includes(row.record_type) && state.has(row.booking_id)) {
      Object.assign(state.get(row.booking_id), {
        status: row.record_type === "cancellation" ? "cancelled" : "calendar_failed",
        cancelled_at: row.cancelled_at || "",
        cancellation_reason: row.reason || ""
      });
    }
  }
  return [...state.values()];
}

function activeBookings(rows) {
  return bookingState(rows).filter((booking) =>
    ["calendar_pending", "confirmed"].includes(booking.status));
}

function publicBooking(booking) {
  return {
    booking_id: booking.booking_id,
    status: booking.status,
    mentor_id: booking.mentor_id,
    mentor_name: booking.mentor_name,
    table: booking.table,
    location: booking.location,
    date: booking.date,
    start_time: booking.start_time,
    end_time: booking.end_time,
    calendar_event_id: booking.calendar_event_id || "",
    calendar_invite_sent: Boolean(booking.calendar_invite_sent),
    checked_in_at: booking.checked_in_at || ""
  };
}

async function availability(env) {
  const schedule = await mentoringSchedule(env);
  const { rows } = await readObject(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY);
  const counts = activeBookings(rows).reduce((result, booking) => {
    const key = `${booking.mentor_id}|${booking.start_time}`;
    result.set(key, (result.get(key) || 0) + 1);
    return result;
  }, new Map());
  const slots = schedule.mentors.flatMap((mentor) => schedule.start_times.map((startTime) => ({
    slot_id: `${mentor.id}-${startTime.replace(":", "")}`,
    mentor_id: mentor.id,
    mentor_name: mentor.name,
    table: mentor.table,
    location: mentor.location,
    date: schedule.date,
    start_time: startTime,
    end_time: addMinutes(startTime, schedule.session_minutes),
    seats_remaining: Math.max(0, FOUNDER_CAPACITY - (counts.get(`${mentor.id}|${startTime}`) || 0)),
    capacity: FOUNDER_CAPACITY,
    available: (counts.get(`${mentor.id}|${startTime}`) || 0) < FOUNDER_CAPACITY,
    mentor_email_configured: mentor.email_configured
  })));
  return json({ ok: true, schedule, slots });
}

async function recordCalendarFailure(env, booking, reason) {
  await mutateJsonLines(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY, () => ({
    record_type: "calendar_failure",
    booking_id: booking.booking_id,
    created_at: new Date().toISOString(),
    reason
  }));
}

async function createBooking(request, env) {
  const body = await requestJson(request);
  const biggestChallenge = String(body.biggest_challenge || "").trim().replace(/\s+/g, " ");
  const participant = {
    name: normalizeGuestName(body.participant_name),
    email: normalizeSpokenEmail(body.participant_email)
  };
  const mentorId = String(body.mentor_id || "").trim();
  const startTime = String(body.start_time || "").trim();
  const mentor = await mentorFor(env, mentorId);
  if (body.event_slug !== STARTUP_WEEK_SLUG || !participant.name || !isEmail(participant.email) ||
      body.email_confirmed !== true || !biggestChallenge || biggestChallenge.length > 500 ||
      !mentor || !START_TIMES.includes(startTime)) {
    return json({ ok: false, reason: "invalid_mentor_booking" }, 400);
  }
  if (!isEmail(mentor.email)) return json({ ok: false, reason: "organizer_email_not_configured" }, 503);
  if (!googleConfigured(env)) return json({ ok: false, reason: "google_not_connected" }, 503);

  const endTime = addMinutes(startTime, SESSION_MINUTES);
  const booking = await mutateJsonLines(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY, (rows) => {
    const active = activeBookings(rows);
    if (active.filter((row) => row.mentor_id === mentorId && row.start_time === startTime).length >= FOUNDER_CAPACITY) {
      return json({ ok: false, reason: "slot_unavailable" }, 409);
    }
    const participantKey = emailIdentityKey(participant.email);
    const replacingBookingId = String(body.replacing_booking_id || "").trim();
    const existing = active.find((row) => row.booking_id !== replacingBookingId &&
      emailIdentityKey(row.participant?.email) === participantKey);
    if (existing) {
      return json({ ok: false, reason: "existing_mentor_booking", booking: publicBooking(existing) }, 409);
    }
    return {
      record_type: "booking",
      booking_id: recordId("MTG"),
      created_at: new Date().toISOString(),
      status: "calendar_pending",
      event_slug: STARTUP_WEEK_SLUG,
      participant,
      biggest_challenge: biggestChallenge,
      mentor_id: mentor.id,
      mentor_name: mentor.name,
      mentor_expertise: mentor.expertise,
      mentor_email: mentor.email,
      notification_email: mentor.email,
      table: mentor.table,
      location: mentor.location,
      date: EVENT_DATE,
      start_time: startTime,
      end_time: endTime,
      timezone: TIMEZONE
    };
  });
  if (booking instanceof Response) return booking;

  let calendar;
  try {
    calendar = await createMentorCalendarBooking(env, booking);
  } catch (error) {
    await recordCalendarFailure(env, booking, error?.reason || "calendar_create_failed");
    return json({ ok: false, reason: error?.reason || "calendar_create_failed" }, error?.status || 502);
  }
  const confirmed = await mutateJsonLines(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY, () => ({
    record_type: "booking_calendar",
    booking_id: booking.booking_id,
    created_at: new Date().toISOString(),
    status: "confirmed",
    calendar_event_id: calendar.event_id,
    calendar_event_url: calendar.event_url,
    calendar_invite_sent: true
  }));
  await sendMentorBookingConfirmation(env, booking).catch(() => null);
  return json({ ok: true, booking: publicBooking({ ...booking, ...confirmed }) });
}

async function findParticipantBooking(env, body) {
  const email = normalizeSpokenEmail(body.participant_email);
  if (!isEmail(email)) return { error: json({ ok: false, reason: "invalid_email" }, 400) };
  const { rows } = await readObject(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY);
  const requestedBookingId = String(body.booking_id || "").trim();
  const booking = activeBookings(rows).find((row) =>
    (!requestedBookingId || row.booking_id === requestedBookingId) &&
    emailIdentityKey(row.participant?.email) === emailIdentityKey(email));
  return booking ? { booking } : { error: json({ ok: false, reason: "mentor_booking_not_found" }, 404) };
}

async function cancelBooking(request, env) {
  const body = await requestJson(request);
  const found = await findParticipantBooking(env, body);
  if (found.error) return found.error;
  const booking = found.booking;
  try {
    if (booking.calendar_event_id) await cancelCalendarBooking(env, booking.calendar_event_id);
  } catch (error) {
    return json({ ok: false, reason: error?.reason || "calendar_cancel_failed" }, error?.status || 502);
  }
  await mutateJsonLines(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY, (rows) => {
    if (!activeBookings(rows).some((row) => row.booking_id === booking.booking_id)) {
      return json({ ok: true, duplicate: true, booking: publicBooking({ ...booking, status: "cancelled" }) });
    }
    return { record_type: "cancellation", booking_id: booking.booking_id,
      cancelled_at: new Date().toISOString(), reason: "participant_cancelled" };
  });
  return json({ ok: true, booking: publicBooking({ ...booking, status: "cancelled" }) });
}

async function checkInBooking(request, env) {
  const body = await requestJson(request);
  const email = normalizeSpokenEmail(body.participant_email);
  if (body.event_slug !== STARTUP_WEEK_SLUG || !isEmail(email)) {
    return json({ ok: false, reason: "invalid_email" }, 400);
  }
  const { rows } = await readObject(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY);
  const booking = activeBookings(rows).find((row) =>
    emailIdentityKey(row.participant?.email) === emailIdentityKey(email));
  if (!booking) return json({ ok: false, reason: "mentor_booking_not_found" }, 404);
  if (!booking.checked_in_at) {
    await mutateJsonLines(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY, () => ({
      record_type: "check_in",
      booking_id: booking.booking_id,
      checked_in_at: new Date().toISOString()
    }));
  }
  return json({ ok: true, booking: publicBooking({
    ...booking,
    checked_in_at: booking.checked_in_at || new Date().toISOString()
  }) });
}

async function rescheduleBooking(request, env) {
  const body = await requestJson(request);
  const found = await findParticipantBooking(env, body);
  if (found.error) return found.error;
  const previous = found.booking;
  const replacementRequest = new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_slug: STARTUP_WEEK_SLUG,
      participant_name: previous.participant.name,
      participant_email: previous.participant.email,
      biggest_challenge: previous.biggest_challenge,
      email_confirmed: true,
      mentor_id: body.mentor_id,
      start_time: body.start_time,
      replacing_booking_id: previous.booking_id
    })
  });
  const replacement = await createBooking(replacementRequest, env);
  if (!replacement.ok) return replacement;
  const result = await replacement.json();
  try {
    if (previous.calendar_event_id) await cancelCalendarBooking(env, previous.calendar_event_id);
  } catch (error) {
    if (result.booking?.calendar_event_id) {
      await cancelCalendarBooking(env, result.booking.calendar_event_id).catch(() => {});
    }
    await mutateJsonLines(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY, () => ({
      record_type: "cancellation", booking_id: result.booking.booking_id,
      cancelled_at: new Date().toISOString(), reason: "reschedule_rollback"
    }));
    return json({ ok: false, reason: error?.reason || "calendar_cancel_failed" }, error?.status || 502);
  }
  await mutateJsonLines(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY, () => ({
    record_type: "cancellation", booking_id: previous.booking_id,
    cancelled_at: new Date().toISOString(), reason: "participant_rescheduled"
  }));
  return json({ ok: true, previous_booking_id: previous.booking_id, booking: result.booking });
}

async function organizerBookings(env, url) {
  if (url.searchParams.get("slug") !== STARTUP_WEEK_SLUG) {
    return json({ ok: false, reason: "event_not_found" }, 404);
  }
  const { rows } = await readObject(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY);
  const schedule = await mentoringSchedule(env);
  const mentorById = new Map(schedule.mentors.map((mentor) => [mentor.id, mentor]));
  const bookings = bookingState(rows).sort((a, b) =>
    a.start_time.localeCompare(b.start_time) || a.table - b.table).map((booking) => ({
      ...booking,
      mentor_expertise: mentorById.get(booking.mentor_id)?.expertise || normalizeExpertise(booking.mentor_expertise)
    }));
  return json({ ok: true, schedule, roster: await mentorRoster(env), bookings });
}

async function publicMentorBoard(env, url) {
  if (url.searchParams.get("slug") !== STARTUP_WEEK_SLUG) {
    return json({ ok: false, reason: "event_not_found" }, 404);
  }
  const { rows } = await readObject(env.PIERCE_DATA, MENTOR_BOOKINGS_KEY);
  const schedule = await mentoringSchedule(env);
  const mentorById = new Map(schedule.mentors.map((mentor) => [mentor.id, mentor]));
  const appointments = activeBookings(rows)
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.table - b.table)
    .map((booking) => ({
      participant_name: publicParticipantName(booking.participant?.name),
      mentor_name: booking.mentor_name,
      mentor_expertise: mentorById.get(booking.mentor_id)?.expertise ||
        normalizeExpertise(booking.mentor_expertise),
      table: booking.table,
      location: booking.location,
      start_time: booking.start_time,
      end_time: booking.end_time,
      checked_in: Boolean(booking.checked_in_at),
      checked_in_at: booking.checked_in_at || ""
    }));
  return Response.json({ ok: true, schedule, appointments }, {
    headers: { "cache-control": "no-store" }
  });
}

async function updateMentorRoster(request, env) {
  const body = await requestJson(request);
  const mentors = normalizeMentorRoster(body.mentors);
  if (!mentors) return json({ ok: false, reason: "invalid_mentor_roster" }, 400);
  await env.PIERCE_DATA.put(MENTOR_ROSTER_KEY, JSON.stringify({
    updated_at: new Date().toISOString(),
    mentors
  }), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, schedule: await mentoringSchedule(env), roster: await mentorRoster(env) });
}

export async function handleMentoringRoute(request, env, organizerIdentity = null) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/event/mentoring/availability") {
    if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
    if (url.searchParams.get("slug") !== STARTUP_WEEK_SLUG) return json({ ok: false, reason: "event_not_found" }, 404);
    return availability(env);
  }
  if (request.method === "GET" && url.pathname === "/event/mentoring/board") {
    if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
    return publicMentorBoard(env, url);
  }
  if (request.method === "GET" && url.pathname === "/event/review/bookings") {
    if (!organizerIdentity) return json({ ok: false, reason: "organizer_access_required" }, 403);
    if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
    return organizerBookings(env, url);
  }
  if (request.method === "POST" && url.pathname === "/event/review/mentors") {
    if (!organizerIdentity) return json({ ok: false, reason: "organizer_access_required" }, 403);
    if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
    return updateMentorRoster(request, env);
  }
  if (request.method !== "POST") return null;
  const postRoutes = new Set([
    "/event/mentoring/book",
    "/event/mentoring/check-in",
    "/event/mentoring/cancel",
    "/event/mentoring/reschedule"
  ]);
  if (!postRoutes.has(url.pathname)) return null;
  if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
  if (url.pathname === "/event/mentoring/book") return createBooking(request, env);
  if (url.pathname === "/event/mentoring/check-in") return checkInBooking(request, env);
  if (url.pathname === "/event/mentoring/cancel") return cancelBooking(request, env);
  if (url.pathname === "/event/mentoring/reschedule") return rescheduleBooking(request, env);
  return null;
}
