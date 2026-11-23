import { emailIdentityKey, isEmail, mutateJsonLines, readObject, recordId } from "./cloudflare-booking.mjs";
import { queueHubspotSync } from "./cloudflare-hubspot.mjs";

const DATASETS = {
  bookings: "pierce-data/booking-requests.jsonl",
  check_ins: "pierce-data/check-in-requests.jsonl",
  career_summaries: "pierce-data/career-session-summaries.jsonl",
  event_intakes: "pierce-data/event-intakes.jsonl",
  event_check_ins: "pierce-data/event-check-ins.jsonl",
  event_summaries: "pierce-data/event-session-summaries.jsonl",
  job_fair_quick_starts: "pierce-data/job-fair-quick-starts.jsonl",
  mentor_bookings: "pierce-data/event-mentor-bookings.jsonl"
};

const AUDIT_KEY = "pierce-data/data-management-audit.jsonl";
const HUBSPOT_SYNCS_KEY = "pierce-data/hubspot-syncs.jsonl";
const MAX_JSON_BYTES = 16 * 1024;
const IDENTIFIER_FIELDS = [
  "request_id", "booking_request_id", "target_booking_request_id", "replacing_booking_id",
  "session_id", "intake_id", "summary_id", "booking_id", "quick_start_id", "check_in_id"
];

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

function eventSlug(row) {
  return String(row?.event?.slug || row?.event_slug || "").trim();
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function hasEmail(row, target) {
  return strings(row).some((value) => value.includes("@") && emailIdentityKey(value) === target);
}

function identifiers(row) {
  return IDENTIFIER_FIELDS.map((field) => row?.[field]).filter(Boolean).map(String);
}

function references(row, ids) {
  return identifiers(row).some((id) => ids.has(id));
}

function relatedRows(datasetRows, predicate) {
  const selected = new Map();
  const ids = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [dataset, rows] of Object.entries(datasetRows)) {
      for (let index = 0; index < rows.length; index += 1) {
        const key = `${dataset}:${index}`;
        if (selected.has(key)) continue;
        const row = rows[index];
        if (!predicate(row) && !references(row, ids)) continue;
        selected.set(key, { dataset, index, row });
        for (const id of identifiers(row)) ids.add(id);
        changed = true;
      }
    }
  }
  return selected;
}

async function loadDatasets(bucket) {
  const entries = await Promise.all(Object.entries(DATASETS).map(async ([name, key]) => {
    const object = await readObject(bucket, key);
    return [name, { ...object, key }];
  }));
  return Object.fromEntries(entries);
}

async function replaceRows(bucket, dataset, rowsToRemove) {
  if (!rowsToRemove.size) return 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readObject(bucket, dataset.key);
    const retained = current.rows.filter((row) => !rowsToRemove.has(JSON.stringify(row)));
    const removed = current.rows.length - retained.length;
    if (!removed) return 0;
    const onlyIf = current.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" };
    const body = retained.map((row) => JSON.stringify(row)).join("\n");
    const written = await bucket.put(dataset.key, body ? `${body}\n` : "", {
      onlyIf,
      httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" }
    });
    if (written) return removed;
  }
  throw new Error(`Concurrent update limit exceeded for ${dataset.key}`);
}

async function participantHash(email) {
  const bytes = new TextEncoder().encode(emailIdentityKey(email));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function inventory(env, url) {
  const slug = String(url.searchParams.get("slug") || "").trim();
  if (!slug) return json({ ok: false, reason: "event_slug_required" }, 400);
  const datasets = await loadDatasets(env.PIERCE_DATA);
  const rows = Object.fromEntries(Object.entries(datasets).map(([name, value]) => [name, value.rows]));
  const selected = relatedRows(rows, (row) => eventSlug(row) === slug);
  const counts = Object.fromEntries(Object.keys(DATASETS).map((name) => [name, 0]));
  for (const item of selected.values()) counts[item.dataset] += 1;
  return json({ ok: true, event_slug: slug, total_records: selected.size, datasets: counts });
}

async function exportData(env, url) {
  const slug = String(url.searchParams.get("slug") || "").trim();
  if (!slug) return json({ ok: false, reason: "event_slug_required" }, 400);
  const datasets = await loadDatasets(env.PIERCE_DATA);
  const rows = Object.fromEntries(Object.entries(datasets).map(([name, value]) => [name, value.rows]));
  const selected = relatedRows(rows, (row) => eventSlug(row) === slug);
  const exported = Object.fromEntries(Object.keys(DATASETS).map((name) => [name, []]));
  for (const item of selected.values()) exported[item.dataset].push(item.row);
  const filename = `pierce-${slug}-export-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify({
    export_version: 1,
    generated_at: new Date().toISOString(),
    event_slug: slug,
    total_records: selected.size,
    datasets: exported
  }, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store"
    }
  });
}

function hubspotCandidate(dataset, row) {
  const mappings = {
    bookings: ["booking", "request_id", row.guest],
    career_summaries: ["career_session", "session_id", row.guest],
    event_check_ins: ["event_check_in", "check_in_id", row.participant],
    event_summaries: ["event_session_summary", "summary_id", row.participant],
    job_fair_quick_starts: ["job_fair_quick_start", "quick_start_id", row.participant]
  };
  let mapping = mappings[dataset];
  if (dataset === "event_intakes") {
    mapping = row.role === "mentor"
      ? ["event_mentor_intake", "intake_id", row.mentor]
      : ["event_participant_intake", "intake_id", row.participant];
  }
  if (!mapping) return null;
  const [sourceType, idField, person = {}] = mapping;
  const sourceId = String(row[idField] || "").trim();
  const email = String(person.email || "").trim();
  if (!sourceId || row.queue_type === "booking_change") return null;
  return {
    dataset,
    source_type: sourceType,
    source_id: sourceId,
    event_slug: eventSlug(row),
    occurred_at: row.approved_at || row.completed_at || row.checked_in_at || row.created_at || "",
    name: String(person.name || "").trim(),
    email,
    record: row
  };
}

async function hubspotCandidates(env) {
  const datasets = await loadDatasets(env.PIERCE_DATA);
  const syncs = await readObject(env.PIERCE_DATA, HUBSPOT_SYNCS_KEY);
  const completed = new Set(syncs.rows
    .filter((row) => row.status === "queued" || row.status === "synced")
    .map((row) => `${row.source_type}:${row.source_id}`));
  const candidates = [];
  for (const [dataset, value] of Object.entries(datasets)) {
    for (const row of value.rows) {
      const candidate = hubspotCandidate(dataset, row);
      if (candidate) candidates.push(candidate);
    }
  }
  return { candidates, completed };
}

async function hubspotBackfillPreview(env) {
  const { candidates, completed } = await hubspotCandidates(env);
  const people = new Map();
  let missingEmailRecords = 0;
  for (const candidate of candidates) {
    if (!isEmail(candidate.email)) {
      missingEmailRecords += 1;
      continue;
    }
    const key = emailIdentityKey(candidate.email);
    const person = people.get(key) || {
      email: candidate.email,
      name: candidate.name,
      total_records: 0,
      ready_records: 0,
      already_synced_records: 0,
      events: new Set(),
      record_types: new Set()
    };
    person.name ||= candidate.name;
    person.total_records += 1;
    if (completed.has(`${candidate.source_type}:${candidate.source_id}`)) person.already_synced_records += 1;
    else person.ready_records += 1;
    if (candidate.event_slug) person.events.add(candidate.event_slug);
    person.record_types.add(candidate.source_type);
    people.set(key, person);
  }
  const contacts = [...people.values()].map((person) => ({
    ...person,
    events: [...person.events].sort(),
    record_types: [...person.record_types].sort(),
    proposed_action: person.ready_records ? "create_or_update_contact_and_add_notes" : "no_action_already_synced"
  })).sort((left, right) => left.email.localeCompare(right.email));
  const readyRecords = contacts.reduce((sum, person) => sum + person.ready_records, 0);
  const syncedRecords = contacts.reduce((sum, person) => sum + person.already_synced_records, 0);
  return json({
    ok: true,
    preview_only: true,
    generated_at: new Date().toISOString(),
    summary: {
      unique_contacts: contacts.length,
      contacts_with_records_ready: contacts.filter((person) => person.ready_records > 0).length,
      records_ready: readyRecords,
      records_already_synced: syncedRecords,
      records_missing_valid_email: missingEmailRecords
    },
    contacts
  });
}

async function runHubspotBackfill(request, env, organizerIdentity) {
  const body = await requestJson(request);
  const requestedEmails = Array.isArray(body.emails) ? body.emails : [];
  const selected = new Set(requestedEmails.map((email) => emailIdentityKey(String(email || "")))
    .filter(Boolean));
  if (body.confirmation !== "BACKFILL" || !selected.size || selected.size > 50) {
    return json({ ok: false, reason: "emails_and_confirmation_required" }, 400);
  }
  const { candidates, completed } = await hubspotCandidates(env);
  const eligible = candidates.filter((candidate) => isEmail(candidate.email) &&
    selected.has(emailIdentityKey(candidate.email)) &&
    !completed.has(`${candidate.source_type}:${candidate.source_id}`));
  const results = [];
  for (const candidate of eligible) {
    const result = await queueHubspotSync(env, candidate.source_type, candidate.record);
    results.push({ source_type: candidate.source_type, source_id: candidate.source_id, status: result.status });
  }
  const queued = results.filter((result) => result.status === "queued").length;
  await mutateJsonLines(env.PIERCE_DATA, AUDIT_KEY, () => ({
    audit_id: recordId("DMA"),
    action: "hubspot_backfill_queued",
    created_at: new Date().toISOString(),
    performed_by: organizerIdentity.email,
    selected_contacts: selected.size,
    records_queued: queued,
    source_records: results.map(({ source_type, source_id }) => ({ source_type, source_id }))
  }));
  return json({ ok: true, selected_contacts: selected.size, records_queued: queued, results });
}

async function deleteParticipant(request, env, organizerIdentity) {
  const body = await requestJson(request);
  const slug = String(body.event_slug || "").trim();
  const email = String(body.participant_email || "").trim();
  if (!slug || !isEmail(email) || body.confirmation !== "DELETE") {
    return json({ ok: false, reason: "event_email_and_confirmation_required" }, 400);
  }
  const target = emailIdentityKey(email);
  const datasets = await loadDatasets(env.PIERCE_DATA);
  const rows = Object.fromEntries(Object.entries(datasets).map(([name, value]) => [name, value.rows]));
  const eventRows = relatedRows(rows, (row) => eventSlug(row) === slug);
  const eventKeys = new Set(eventRows.keys());
  const participantRows = relatedRows(rows, (row) => hasEmail(row, target));
  const selected = new Map([...participantRows].filter(([key]) => eventKeys.has(key)));
  const removals = Object.fromEntries(Object.keys(DATASETS).map((name) => [name, new Set()]));
  for (const item of selected.values()) removals[item.dataset].add(JSON.stringify(item.row));
  const removedByDataset = {};
  for (const [name, dataset] of Object.entries(datasets)) {
    removedByDataset[name] = await replaceRows(env.PIERCE_DATA, dataset, removals[name]);
  }
  const totalRemoved = Object.values(removedByDataset).reduce((sum, count) => sum + count, 0);
  const hash = await participantHash(email);
  const audit = await mutateJsonLines(env.PIERCE_DATA, AUDIT_KEY, () => ({
    audit_id: recordId("DMA"),
    action: "delete_participant_data",
    created_at: new Date().toISOString(),
    event_slug: slug,
    participant_hash: hash,
    performed_by: organizerIdentity.email,
    total_removed: totalRemoved,
    removed_by_dataset: removedByDataset
  }));
  return json({ ok: true, event_slug: slug, total_removed: totalRemoved,
    removed_by_dataset: removedByDataset, audit_id: audit.audit_id });
}

export async function handleDataManagementRoute(request, env, organizerIdentity = null) {
  const url = new URL(request.url);
  const routes = new Set([
    "/organizer/data/inventory",
    "/organizer/data/export",
    "/organizer/data/delete",
    "/organizer/data/hubspot-backfill-preview",
    "/organizer/data/hubspot-backfill"
  ]);
  if (!routes.has(url.pathname)) return null;
  if (!organizerIdentity) return json({ ok: false, reason: "organizer_access_required" }, 403);
  if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
  if (request.method === "GET" && url.pathname === "/organizer/data/inventory") return inventory(env, url);
  if (request.method === "GET" && url.pathname === "/organizer/data/export") return exportData(env, url);
  if (request.method === "GET" && url.pathname === "/organizer/data/hubspot-backfill-preview") {
    return hubspotBackfillPreview(env);
  }
  if (request.method === "POST" && url.pathname === "/organizer/data/hubspot-backfill") {
    return runHubspotBackfill(request, env, organizerIdentity);
  }
  if (request.method === "POST" && url.pathname === "/organizer/data/delete") {
    return deleteParticipant(request, env, organizerIdentity);
  }
  return json({ ok: false, reason: "method_not_allowed" }, 405);
}
