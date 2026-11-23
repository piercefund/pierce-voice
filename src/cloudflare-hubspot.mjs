const HUBSPOT_SYNCS_KEY = "pierce-data/hubspot-syncs.jsonl";
const DATA_MANAGEMENT_AUDIT_KEY = "pierce-data/data-management-audit.jsonl";
const BOOKING_KEY = "pierce-data/booking-requests.jsonl";
const CAREER_KEY = "pierce-data/career-session-summaries.jsonl";
const NOTE_ASSOCIATION_TYPE = 202;
const MAX_MANUAL_SYNC_BODY_BYTES = 16 * 1024;

function recordId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

async function readObject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return { rows: [], text: "", etag: null };
  const text = await object.text();
  return { rows: text.split("\n").filter(Boolean).map((line) => JSON.parse(line)), text, etag: object.etag };
}

async function mutateJsonLines(bucket, key, buildRecord) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readObject(bucket, key);
    const record = await buildRecord(current.rows);
    const onlyIf = current.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" };
    const written = await bucket.put(key, `${current.text}${JSON.stringify(record)}\n`, {
      onlyIf, httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" }
    });
    if (written) return record;
  }
  throw new Error(`Concurrent update limit exceeded for ${key}`);
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return { firstname: parts.shift() || "", lastname: parts.join(" ") };
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function noteBody(lines) {
  return lines.map(escapeHtml).join("<br>");
}

function guestFor(record) {
  return record.guest || record.participant || record.mentor || {};
}

async function emailHash(email) {
  const value = String(email || "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  let local = at === -1 ? value : value.slice(0, at);
  let domain = at === -1 ? "" : value.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.split("+")[0].replace(/\./g, "");
    domain = "gmail.com";
  }
  const normalized = domain ? `${local}@${domain}` : local;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function participantWasDeleted(env, record) {
  const email = guestFor(record).email;
  const slug = String(record.event?.slug || record.event_slug || "");
  if (!email || !slug) return false;
  const hash = await emailHash(email);
  const { rows } = await readObject(env.PIERCE_DATA, DATA_MANAGEMENT_AUDIT_KEY);
  return rows.some((row) => row.action === "delete_participant_data" &&
    row.event_slug === slug && row.participant_hash === hash);
}

function sourceId(sourceType, record) {
  const fields = {
    booking: "request_id",
    career_session: "session_id",
    event_participant_intake: "intake_id",
    event_mentor_intake: "intake_id",
    event_check_in: "check_in_id",
    event_session_summary: "summary_id",
    job_fair_quick_start: "quick_start_id"
  };
  return String(record?.[fields[sourceType]] || "");
}

function buildNote(sourceType, record) {
  if (sourceType === "booking") {
    return noteBody([
      "Pierce booking", "Journey stage: Tourist",
      `Session: ${record.date || ""} at ${record.time || ""} Pacific`,
      `Duration: ${record.duration_minutes || 15} minutes`,
      `Reason: ${record.guest?.topic || ""}`,
      `Booking reference: ${record.request_id || ""}`,
      `Calendar status: ${record.status || ""}`
    ]);
  }
  if (sourceType === "career_session") {
    return noteBody([
      "Pierce career session summary",
      `Session reference: ${record.session_id || ""}`,
      `Booking reference: ${record.booking_request_id || ""}`,
      `Booked session: ${record.booking?.date || ""} at ${record.booking?.time || ""} Pacific`,
      `Original reason: ${record.booking?.topic || ""}`,
      `City: ${record.discovery?.guest_city || ""}`,
      `Desired outcome: ${record.discovery?.useful_outcome || ""}`,
      `Career direction: ${record.discovery?.career_direction || ""}`,
      `Strengths and experience: ${record.discovery?.strengths_experience || ""}`,
      `Primary challenge: ${record.discovery?.primary_challenge || ""}`,
      `Recommended event: ${record.recommended_event?.name || ""}`,
      `Resource: ${record.resource?.name || ""}${record.resource?.url ? ` - ${record.resource.url}` : ""}`,
      `Confirmed next step: ${record.next_step?.action || ""}`,
      `Target date: ${record.next_step?.target_date || ""}`
    ]);
  }
  if (sourceType === "job_fair_quick_start") {
    return noteBody([
      `Pierce event: ${record.event?.name || "Job fair"}`,
      "Event stage: quick start", "Journey stage: Tourist",
      `Participant: ${record.participant?.name || ""}`,
      `Career interest: ${record.job_interest || ""}`,
      `Strength or experience: ${record.strength_or_experience || ""}`,
      `Immediate challenge: ${record.immediate_challenge || ""}`,
      `Employer question: ${record.employer_question || ""}`,
      `Resource: ${record.resource?.name || ""}${record.resource?.url ? ` - ${record.resource.url}` : ""}`,
      `Next step: ${record.next_step?.action || ""}`,
      `Target date: ${record.next_step?.target_date || ""}`
    ]);
  }
  const lines = [
    `Pierce event: ${record.event?.name || ""}`,
    `Event stage: ${sourceType.replaceAll("_", " ")}`,
    "Journey stage: Tourist"
  ];
  if (sourceType === "event_participant_intake") lines.push(
    `Participant: ${record.participant?.name || ""}`,
    `City: ${record.guest_city || ""}`,
    `Career stage: ${record.career_stage || ""}`,
    `Career goal: ${record.career_goal || ""}`,
    `Primary challenge: ${record.primary_challenge || ""}`,
    `Mentor questions: ${(record.mentor_questions || []).join(" | ")}`
  );
  if (sourceType === "event_mentor_intake") lines.push(
    `Mentor: ${record.mentor?.name || ""}`,
    `Expertise: ${record.expertise || ""}`,
    `Support offered: ${record.support_offered || ""}`,
    `Resource offered: ${record.resource_offered || ""}`
  );
  if (sourceType === "event_check_in") lines.push(
    `Participant: ${record.participant?.name || ""}`,
    `Checked in: ${record.checked_in_at || ""}`,
    `Career goal: ${record.career_goal || ""}`
  );
  if (sourceType === "event_session_summary") lines.push(
    `Participant: ${record.participant?.name || ""}`,
    `Guidance: ${(record.key_guidance || []).join(" | ")}`,
    `Mentor connection: ${record.mentor_connection || ""}`,
    `Event recommendation: ${record.recommended_event || ""}`,
    `Resource: ${record.recommended_resource || ""}`,
    `Next step: ${record.next_step?.action || ""}`,
    `Next-step owner: ${record.next_step?.owner || ""}`,
    `Target date: ${record.next_step?.target_date || ""}`
  );
  return noteBody(lines);
}

async function hubspotRequest(env, path, options = {}) {
  if (!env.HUBSPOT_SERVICE_KEY) throw Object.assign(new Error("HubSpot is not configured."), { status: 503 });
  const response = await fetch(`${env.HUBSPOT_API_BASE || "https://api.hubapi.com"}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${env.HUBSPOT_SERVICE_KEY}`,
      "content-type": "application/json",
      ...options.headers
    }
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: "HubSpot returned an invalid response." }; }
  if (!response.ok) throw Object.assign(new Error(body.message || `HubSpot returned ${response.status}.`), {
    status: response.status
  });
  return body;
}

async function upsertContact(env, record) {
  const guest = guestFor(record);
  const email = String(guest.email || "").trim();
  if (!email) throw Object.assign(new Error("HubSpot sync record has no email."), { status: 400 });
  const properties = { email, ...splitName(guest.name) };
  if (guest.phone) properties.phone = guest.phone;
  try {
    const existing = await hubspotRequest(env,
      `/crm/objects/2026-03/contacts/${encodeURIComponent(email)}?idProperty=email`);
    return hubspotRequest(env, `/crm/objects/2026-03/contacts/${existing.id}`, {
      method: "PATCH", body: JSON.stringify({ properties })
    });
  } catch (error) {
    if (error.status !== 404) throw error;
    return hubspotRequest(env, "/crm/objects/2026-03/contacts", {
      method: "POST", body: JSON.stringify({ properties })
    });
  }
}

async function alreadySynced(env, sourceType, id) {
  const { rows } = await readObject(env.PIERCE_DATA, HUBSPOT_SYNCS_KEY);
  return rows.find((row) => row.source_type === sourceType && row.source_id === id && row.status === "synced") || null;
}

async function recordSync(env, entry) {
  return mutateJsonLines(env.PIERCE_DATA, HUBSPOT_SYNCS_KEY, () => ({
    sync_id: recordId("CRM"), created_at: new Date().toISOString(), ...entry
  }));
}

export async function queueHubspotSync(env, sourceType, record) {
  const id = sourceId(sourceType, record);
  if (!env.HUBSPOT_SYNC_QUEUE) return { status: "skipped", reason: "hubspot_queue_not_configured" };
  if (!env.HUBSPOT_SERVICE_KEY) return { status: "skipped", reason: "hubspot_secret_not_configured" };
  if (!id) return { status: "skipped", reason: "hubspot_source_id_missing" };
  if (!guestFor(record).email) return { status: "skipped", reason: "hubspot_contact_email_missing" };
  try {
    await env.HUBSPOT_SYNC_QUEUE.send({ version: 1, source_type: sourceType, source_id: id, record }, {
      contentType: "json"
    });
    await recordSync(env, { source_type: sourceType, source_id: id, status: "queued" });
    return { status: "queued", source_type: sourceType, source_id: id };
  } catch (error) {
    await recordSync(env, { source_type: sourceType, source_id: id, status: "queue_failed",
      error: String(error?.message || "queue_send_failed").slice(0, 300) });
    return { status: "failed", reason: "hubspot_queue_send_failed" };
  }
}

async function syncMessage(env, body) {
  const sourceType = String(body?.source_type || "");
  const id = String(body?.source_id || "");
  const record = body?.record;
  if (!sourceType || !id || !record || sourceId(sourceType, record) !== id) {
    throw Object.assign(new Error("Invalid HubSpot queue message."), { status: 400 });
  }
  if (await participantWasDeleted(env, record)) {
    return recordSync(env, { completed_at: new Date().toISOString(), source_type: sourceType,
      source_id: id, status: "skipped_deleted_participant" });
  }
  const completed = await alreadySynced(env, sourceType, id);
  if (completed) return { ...completed, duplicate: true };
  const contact = await upsertContact(env, record);
  const note = await hubspotRequest(env, "/crm/objects/2026-03/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_timestamp: record.approved_at || record.completed_at || record.checked_in_at || record.created_at,
        hs_note_body: buildNote(sourceType, record)
      },
      associations: [{ to: { id: contact.id }, types: [{
        associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_ASSOCIATION_TYPE
      }] }]
    })
  });
  return recordSync(env, { completed_at: new Date().toISOString(), source_type: sourceType,
    source_id: id, status: "synced", hubspot_contact_id: contact.id, hubspot_note_id: note.id });
}

function isBookingRecord(record) {
  return record?.queue_type === "booking" && typeof record.request_id === "string" &&
    record.guest && typeof record.guest === "object";
}

async function boundedJson(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MANUAL_SYNC_BODY_BYTES) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_MANUAL_SYNC_BODY_BYTES) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
}

function json(body, status = 200) {
  return Response.json(body, { status });
}

async function manualBookingSync(env) {
  const { rows } = await readObject(env.PIERCE_DATA, BOOKING_KEY);
  const booking = [...rows].reverse().find(isBookingRecord);
  if (!booking) return json({ ok: false, reason: "booking_not_found" }, 404);
  const result = await syncMessage(env, {
    source_type: "booking", source_id: booking.request_id, record: booking
  });
  return json({
    ok: true,
    booking_request_id: booking.request_id,
    guest_name: booking.guest?.name || "",
    date: booking.date || "",
    time: booking.time || "",
    status: result.status,
    duplicate: result.duplicate === true,
    hubspot_contact_id: result.hubspot_contact_id,
    hubspot_note_id: result.hubspot_note_id
  });
}

async function manualCareerSync(request, env) {
  const body = await boundedJson(request);
  const sessionId = String(body.session_id || "").trim();
  const bookingRequestId = String(body.booking_request_id || "").trim();
  const guestName = String(body.guest_name || "").trim().toLowerCase();
  const { rows } = await readObject(env.PIERCE_DATA, CAREER_KEY);
  const session = [...rows].reverse().find((candidate) => {
    if (candidate?.status !== "completed") return false;
    if (sessionId) return candidate.session_id === sessionId;
    if (bookingRequestId) return candidate.booking_request_id === bookingRequestId;
    if (guestName) return String(candidate.guest?.name || "").trim().toLowerCase() === guestName;
    return true;
  });
  if (!session) return json({ ok: false, reason: "career_session_not_found" }, 404);
  const result = await syncMessage(env, {
    source_type: "career_session", source_id: session.session_id, record: session
  });
  return json({
    ok: true,
    session_id: session.session_id,
    booking_request_id: session.booking_request_id,
    guest_name: session.guest?.name || "",
    status: result.status,
    duplicate: result.duplicate === true,
    hubspot_contact_id: result.hubspot_contact_id,
    hubspot_note_id: result.hubspot_note_id
  });
}

export async function handleHubspotRoute(request, env) {
  const { pathname } = new URL(request.url);
  if (!["/hubspot/sync/latest-booking", "/hubspot/sync/career-session"].includes(pathname)) {
    return null;
  }
  if (request.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);
  if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
  if (!env.HUBSPOT_SERVICE_KEY) return json({ ok: false, reason: "hubspot_service_key_not_set" }, 503);
  try {
    return pathname === "/hubspot/sync/latest-booking"
      ? await manualBookingSync(env)
      : await manualCareerSync(request, env);
  } catch (error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
      ? error.status : 502;
    return json({ ok: false, reason: status < 500 ? "invalid_request" : "hubspot_sync_failed" }, status);
  }
}

export async function processHubspotQueue(batch, env) {
  for (const message of batch.messages) {
    try {
      await syncMessage(env, message.body);
      message.ack();
    } catch (error) {
      const sourceType = String(message.body?.source_type || "unknown");
      const id = String(message.body?.source_id || "unknown");
      const permanent = error?.status >= 400 && error?.status < 500 && error?.status !== 429;
      await recordSync(env, { source_type: sourceType, source_id: id,
        status: permanent ? "failed" : "retrying", error_status: error?.status || 500,
        error: String(error?.message || "hubspot_sync_failed").slice(0, 300) });
      if (permanent) message.ack();
      else message.retry();
    }
  }
}
