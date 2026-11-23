import {
  bookingSummary,
  emailIdentityKey,
  isEmail,
  mutateJsonLines,
  nameKey,
  normalizeGuestName,
  readObject,
  recordId,
  todayInPacific,
  uncancelledBookingRows
} from "./cloudflare-booking.mjs";
import { googleConfigured, sendGmail } from "./cloudflare-google-api.mjs";
import { createGuestTakeaway } from "./cloudflare-guest-takeaway.mjs";
import { queueHubspotSync } from "./cloudflare-hubspot.mjs";
import { PIERCE_APPROVED_RESOURCES } from "./pierce-approved-resources.mjs";
import {
  isSanDiegoBased,
  SAN_DIEGO_WORKFORCE_UPDATES,
  sanDiegoWorkforceEmailLines
} from "./pierce-san-diego-updates.mjs";

const BOOKING_KEY = "pierce-data/booking-requests.jsonl";
const CAREER_KEY = "pierce-data/career-session-summaries.jsonl";
const MAX_JSON_BYTES = 64 * 1024;

const careerResources = Object.fromEntries(
  Object.entries(PIERCE_APPROVED_RESOURCES).map(([key, resource]) => [key, {
    name: resource.name,
    url: resource.url,
    description: [resource.description, resource.eligibility].filter(Boolean).join(" ")
  }])
);

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

function compactText(value, maxLength = 800) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trim()}...`;
}

function normalizeEventFormat(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["in_person", "inperson"].includes(text)) return "in_person";
  if (["online", "virtual", "remote"].includes(text)) return "online";
  return text;
}

function normalizeMentorPreference(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["online", "virtual", "remote", "video", "phone"].includes(text)) return "online";
  if (["in_person", "inperson", "local", "face_to_face", "face_to_face_meetings"].includes(text)) return "in_person";
  if (["either", "both", "any", "flexible", "no_preference"].includes(text)) return "either";
  return "not_discussed";
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`))) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10);
}

function titleCase(value) {
  return compactText(value).toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function subjectTopic(discovery, booking) {
  const raw = discovery.career_direction || booking.guest?.topic || "career";
  const cleaned = compactText(raw).replace(/\bsession\b/gi, "").replace(/\bcareer\b/gi, "").replace(/\s+/g, " ").trim();
  const base = titleCase(cleaned || "Career");
  return /\bcareer\b/i.test(base) ? base : `${base} Career`;
}

function occurrenceLabel(number) {
  const labels = ["", "Initial Session", "Second Session", "Third Session", "Fourth Session", "Fifth Session"];
  return labels[number] || `Session ${number}`;
}

function mentorConnection(discovery, preference) {
  const direction = compactText(discovery.career_direction, 120) || "this career direction";
  return {
    name: "SCORE Find a Mentor",
    url: "https://www.score.org/find-mentor",
    location_url: "https://www.score.org/find-location",
    description: "Request free one-on-one mentoring from experienced business mentors. Online mentoring is available, and local chapters may offer in-person options.",
    preference,
    preference_label: preference === "online" ? "Online mentoring" : preference === "in_person" ? "Local in-person mentoring if available" : preference === "either" ? "Online or local in-person mentoring" : "Not discussed",
    reason: `SCORE gives the guest a practical way to request an experienced mentor while exploring ${direction}.`
  };
}

function careerBookingSummary(row) {
  const { guest_email: _email, ...summary } = bookingSummary(row);
  return summary;
}

function previousSessionMemory(session) {
  if (!session) return null;
  const action = compactText(session.next_step?.action, 240).replace(/[.?!]+$/g, "");
  const targetDate = compactText(session.next_step?.target_date, 40);
  const followUp = action
    ? `Last time, your next step was to ${action[0].toLowerCase()}${action.slice(1)}${targetDate ? ` by ${targetDate}` : ""}. Did you get to do that, and how did it go?`
    : "Since your last session, what changed or became clearer for you?";
  return {
    completed_at: session.completed_at || session.created_at || "",
    subject_topic: session.subject_topic || "Career",
    session_occurrence_label: session.session_occurrence_label || "",
    useful_outcome: compactText(session.discovery?.useful_outcome, 240),
    career_direction: compactText(session.discovery?.career_direction, 160),
    next_step: { action: compactText(session.next_step?.action, 240), target_date: targetDate },
    recommended_event: {
      name: compactText(session.recommended_event?.name, 160),
      format: normalizeEventFormat(session.recommended_event?.format),
      reason: compactText(session.recommended_event?.reason, 240)
    },
    resource: {
      name: compactText(session.resource?.name, 120),
      url: String(session.resource?.url || ""),
      description: compactText(session.resource?.description, 240)
    },
    follow_up_question: followUp
  };
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function followUpBody(session) {
  return [
    `Hi ${firstName(session.guest.name)},`,
    "",
    "Thank you for meeting with Pierce.",
    "",
    "Your goal",
    session.discovery.useful_outcome,
    "",
    "Recommended event",
    `${session.recommended_event.name} (${session.recommended_event.format === "in_person" ? "In person" : "Online"})`,
    session.recommended_event.reason,
    "",
    "Resource",
    `${session.resource.name}: ${session.resource.url}`,
    session.resource.description,
    "",
    "Mentor connection",
    `${session.mentor_connection.name}: ${session.mentor_connection.url}`,
    session.mentor_connection.reason,
    "",
    "Your confirmed next step",
    `${session.next_step.action} by ${session.next_step.target_date}.`,
    "",
    ...sanDiegoWorkforceEmailLines(session.discovery?.guest_city),
    "Keep going.",
    "",
    "Pierce"
  ].join("\n");
}

function careerTakeaway(session) {
  const items = [
    { label: "Your goal", title: session.discovery.useful_outcome },
    {
      label: "Recommended event",
      title: session.recommended_event.name,
      meta: session.recommended_event.format === "in_person" ? "In person" : "Online",
      detail: session.recommended_event.reason
    },
    {
      label: "Resource",
      title: session.resource.name,
      detail: session.resource.description,
      url: session.resource.url
    },
    {
      label: "Mentor connection",
      title: session.mentor_connection.name,
      detail: session.mentor_connection.reason,
      url: session.mentor_connection.url
    },
    {
      label: "Next step",
      title: session.next_step.action,
      meta: `By ${session.next_step.target_date}`
    }
  ];
  if (isSanDiegoBased(session.discovery?.guest_city)) {
    items.push({
      label: "Optional San Diego updates",
      title: SAN_DIEGO_WORKFORCE_UPDATES.name,
      detail: `${SAN_DIEGO_WORKFORCE_UPDATES.description} Pierce will not subscribe you automatically.`,
      url: SAN_DIEGO_WORKFORCE_UPDATES.url
    });
  }
  return {
    kind: "summary",
    eyebrow: "YOUR CAREER SESSION SUMMARY",
    title: session.email_subject,
    description: "Your event, resource, mentor connection, and confirmed next step.",
    email_title: "Email this summary",
    email_description: "Receive one email with your career plan. No subscription or marketing.",
    items
  };
}

async function lookupCareer(request, env) {
  const body = await requestJson(request);
  const guestName = normalizeGuestName(body.guest_name);
  const guestIdentity = nameKey(guestName);
  const targetDate = String(body.date || todayInPacific()).trim();
  if (!guestIdentity) return json({ ok: false, reason: "missing_guest_name" }, 400);
  const { rows } = await readObject(env.PIERCE_DATA, BOOKING_KEY);
  const matches = uncancelledBookingRows(rows).filter((row) => {
    const candidate = nameKey(row.guest.name);
    return candidate === guestIdentity || candidate.includes(guestIdentity) || guestIdentity.includes(candidate);
  }).sort((a, b) => Number(a.date !== targetDate) - Number(b.date !== targetDate) || `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`)).slice(0, 4).map(careerBookingSummary);
  return json({ ok: true, guest_name: guestName, date: targetDate, match_count: matches.length, matches });
}

async function loadMemory(request, env) {
  const body = await requestJson(request);
  const bookingId = String(body.booking_request_id || "").trim();
  const guestEmail = String(body.guest_email || "").trim().toLowerCase().replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
  if (!bookingId) return json({ ok: false, reason: "missing_booking" }, 400);
  if (!isEmail(guestEmail) || body.email_confirmed !== true) return json({ ok: false, reason: "email_not_confirmed" }, 400);
  const { rows: bookingRows } = await readObject(env.PIERCE_DATA, BOOKING_KEY);
  const booking = uncancelledBookingRows(bookingRows).find((row) => row.request_id === bookingId);
  if (!booking) return json({ ok: false, reason: "booking_not_found" }, 404);
  if (emailIdentityKey(booking.guest.email) !== emailIdentityKey(guestEmail)) return json({ ok: false, reason: "email_does_not_match_booking" }, 403);
  const { rows: sessions } = await readObject(env.PIERCE_DATA, CAREER_KEY);
  const previous = sessions.filter((session) => session.status === "completed" && session.booking_request_id !== bookingId && emailIdentityKey(session.guest?.email) === emailIdentityKey(booking.guest.email)).sort((a, b) => Date.parse(b.completed_at || b.created_at || "") - Date.parse(a.completed_at || a.created_at || ""))[0];
  return json({ ok: true, returning_guest: Boolean(previous), previous_session: previousSessionMemory(previous) });
}

async function completeCareer(request, env) {
  const body = await requestJson(request);
  const bookingId = String(body.booking_request_id || "").trim();
  const event = body.recommended_event && typeof body.recommended_event === "object" ? {
    name: compactText(body.recommended_event.name, 160),
    format: normalizeEventFormat(body.recommended_event.format),
    reason: compactText(body.recommended_event.reason, 500)
  } : {};
  const discovery = {
    guest_city: compactText(body.guest_city, 160),
    useful_outcome: compactText(body.useful_outcome),
    career_direction: compactText(body.career_direction),
    strengths_experience: compactText(body.strengths_experience),
    primary_challenge: compactText(body.primary_challenge)
  };
  const nextStep = { action: compactText(body.next_step), target_date: normalizeDate(body.next_step_target_date), confirmed: body.next_step_confirmed === true };
  const missing = [];
  if (!bookingId) missing.push("booking_request_id");
  for (const [key, value] of Object.entries(discovery)) if (!value) missing.push(key);
  if (!event.name) missing.push("recommended_event.name");
  if (!["online", "in_person"].includes(event.format)) missing.push("recommended_event.format");
  if (!event.reason) missing.push("recommended_event.reason");
  if (!careerResources[body.resource_key]) missing.push("resource_key");
  if (!nextStep.action) missing.push("next_step");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextStep.target_date)) missing.push("next_step_target_date");
  if (!nextStep.confirmed) missing.push("next_step_confirmed");
  if (body.recording_consent !== true) missing.push("recording_consent");
  if (typeof body.email_consent !== "boolean") missing.push("email_consent");
  if (missing.length) return json({ ok: false, reason: "incomplete_career_session", missing_fields: missing }, 400);

  const { rows: bookingRows } = await readObject(env.PIERCE_DATA, BOOKING_KEY);
  const booking = uncancelledBookingRows(bookingRows).find((row) => row.request_id === bookingId);
  if (!booking) return json({ ok: false, reason: "booking_not_found" }, 404);

  const saved = await mutateJsonLines(env.PIERCE_DATA, CAREER_KEY, (sessions) => {
    const existing = sessions.find((session) => session.booking_request_id === bookingId && session.status === "completed");
    if (existing) {
      const delivery = [...sessions].reverse().find((row) => row.record_type === "email_delivery" && row.session_id === existing.session_id);
      return json({
      ok: true, duplicate: true, session_id: existing.session_id, email_sent: delivery?.status === "sent",
      email_queued: delivery?.status === "pending_delivery", email_subject: existing.email_subject || "", subject_topic: existing.subject_topic || "",
      session_occurrence: existing.session_occurrence || null, session_occurrence_label: existing.session_occurrence_label || "",
      mentor_connection: existing.mentor_connection || null, research_enhanced: false, calendar_update_queued: false
    });
    }
    const topic = subjectTopic(discovery, booking);
    const occurrence = sessions.filter((session) => session.status === "completed" && emailIdentityKey(session.guest?.email) === emailIdentityKey(booking.guest.email) && String(session.subject_topic || "").toLowerCase() === topic.toLowerCase()).length + 1;
    const label = occurrenceLabel(occurrence);
    const preference = normalizeMentorPreference(body.mentor_connection_preference);
    const completedAt = new Date().toISOString();
    return {
      session_id: recordId("SES"), created_at: completedAt, completed_at: completedAt,
      queue_type: "career_session", status: "completed", booking_request_id: booking.request_id,
      guest: { name: booking.guest.name, email: booking.guest.email },
      booking: { date: booking.date, time: booking.time, topic: booking.guest.topic },
      discovery, previous_session_reflection: compactText(body.previous_session_reflection, 900),
      recommended_event: event, mentor_connection_preference: preference,
      mentor_connection: mentorConnection(discovery, preference), next_step: nextStep,
      resource: careerResources[body.resource_key], subject_topic: topic,
      session_occurrence: occurrence, session_occurrence_label: label,
      email_subject: `${topic} - ${label}`, research_follow_up: null, research_enhanced: false,
      recording_consent: true, calendar_update_consent: false, calendar_update_queued: false,
      email_consent: body.email_consent, email_sent: false, email_queued: false,
      staging_integrations: { calendar: "disabled", email: googleConfigured(env) ? "configured" : "disabled", research: "disabled", hubspot: "disabled" }
    };
  });
  if (saved instanceof Response) return saved;
  let emailSent = false;
  let emailQueued = false;
  let emailId = "";
  if (body.email_consent === true && googleConfigured(env)) {
    emailId = recordId("EML");
    let delivery;
    try {
      const result = await sendGmail(env, { to: saved.guest.email, subject: saved.email_subject, body: followUpBody(saved) });
      emailSent = true;
      delivery = { record_type: "email_delivery", email_id: emailId, session_id: saved.session_id,
        booking_request_id: saved.booking_request_id, created_at: new Date().toISOString(), status: "sent",
        provider_message_id: result.id || "", consent_confirmed: true };
    } catch (error) {
      emailQueued = true;
      delivery = { record_type: "email_delivery", email_id: emailId, session_id: saved.session_id,
        booking_request_id: saved.booking_request_id, created_at: new Date().toISOString(), status: "pending_delivery",
        delivery_error: error?.reason || "google_email_delivery_failed", consent_confirmed: true };
    }
    await mutateJsonLines(env.PIERCE_DATA, CAREER_KEY, () => delivery);
  }
  const hubspotSync = await queueHubspotSync(env, "career_session", saved);
  const delivery = body.delivery_mode === "guest_takeaway"
    ? await createGuestTakeaway(env, {
        kind: "career_session_summary",
        subject: saved.email_subject,
        body: followUpBody(saved)
      })
    : { delivery_id: "", email_available: false };
  return json({
    ok: true, session_id: saved.session_id, email_sent: emailSent, email_queued: emailQueued, email_id: emailId,
    calendar_update_queued: false, calendar_update_request_id: "", recommended_event: saved.recommended_event,
    mentor_connection: saved.mentor_connection, resource: saved.resource, next_step: saved.next_step.action,
    next_step_target_date: saved.next_step.target_date, email_subject: saved.email_subject,
    subject_topic: saved.subject_topic, session_occurrence: saved.session_occurrence,
    session_occurrence_label: saved.session_occurrence_label, research_enhanced: false,
    takeaway: careerTakeaway(saved), ...delivery, hubspot_sync: hubspotSync
  });
}

export async function handleCareerRoute(request, env) {
  if (request.method !== "POST") return null;
  const path = new URL(request.url).pathname;
  if (!["/career-session/lookup", "/career-session/memory", "/career-session/complete"].includes(path)) return null;
  if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
  if (path === "/career-session/lookup") return lookupCareer(request, env);
  if (path === "/career-session/memory") return loadMemory(request, env);
  return completeCareer(request, env);
}
