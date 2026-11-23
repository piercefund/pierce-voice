import {
  emailIdentityKey,
  isEmail,
  mutateJsonLines,
  nameKey,
  normalizeGuestName,
  normalizePhoneNumber,
  normalizeSpokenEmail,
  readObject,
  recordId
} from "./cloudflare-booking.mjs";
import { GoogleApiError, googleConfigured, sendGmail } from "./cloudflare-google-api.mjs";
import { createGuestTakeaway } from "./cloudflare-guest-takeaway.mjs";
import { queueHubspotSync } from "./cloudflare-hubspot.mjs";

const EVENT_INTAKES_KEY = "pierce-data/event-intakes.jsonl";
const EVENT_CHECK_INS_KEY = "pierce-data/event-check-ins.jsonl";
const EVENT_SUMMARIES_KEY = "pierce-data/event-session-summaries.jsonl";
const JOB_FAIR_QUICK_STARTS_KEY = "pierce-data/job-fair-quick-starts.jsonl";
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

function configuredEvents(env) {
  const primary = {
    slug: env.PIERCE_EVENT_SLUG || "city-highlights-careers",
    name: env.PIERCE_EVENT_NAME || "City Highlights for Careers",
    date_label: env.PIERCE_EVENT_DATE_LABEL || "September 2026",
    location_label: env.PIERCE_EVENT_LOCATION_LABEL || "Cafe location shared with participants",
    duration_minutes: Number(env.PIERCE_EVENT_DURATION_MINUTES || 120),
    session_minutes: Number(env.PIERCE_EVENT_SESSION_MINUTES || 45)
  };
  const startupWeek = {
    slug: "san-diego-startup-week-mentoring",
    name: "San Diego Startup Week Mentoring",
    date_label: "November 2, 2026",
    location_label: "Carlsbad location shared with participants",
    duration_minutes: 120,
    session_minutes: 45
  };
  const startupWeekGuide = {
    slug: "san-diego-startup-week-guide",
    name: "San Diego Startup Week Guide",
    date_label: "November 2–6, 2026",
    location_label: "Events across San Diego",
    duration_minutes: 5,
    session_minutes: 5,
    experience: "startup_week_guide"
  };
  const loganHeightsJobFair = {
    slug: "logan-heights-job-fair",
    name: "Logan Heights Job Fair",
    date_label: "October 28, 2026",
    location_label: "Logan Heights, San Diego",
    duration_minutes: 5,
    session_minutes: 5,
    experience: "job_fair_quick_start"
  };
  const phoneCareerCheckIn = {
    slug: "pierce-phone-career-check-in",
    name: "Pierce Career Check-In",
    date_label: "Walk-in phone session",
    location_label: "Phone",
    duration_minutes: 5,
    session_minutes: 5,
    experience: "career_quick_start"
  };
  return new Map([primary, startupWeek, startupWeekGuide, loganHeightsJobFair, phoneCareerCheckIn]
    .map((event) => [event.slug, event]));
}

function configuredEvent(env, slug) {
  return configuredEvents(env).get(String(slug || "").trim()) || null;
}

function normalizeStringList(value, limit) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit)
    : [];
}

function isIsoDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
}

function skippedHubSpot() { return { status: "skipped", reason: "hubspot_queue_not_configured" }; }

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function eventFollowUpBody(summary) {
  return [
    `Hi ${firstName(summary.participant.name)},`,
    "",
    `Thank you for taking part in ${summary.event.name}.`,
    "",
    "Guidance from your session",
    ...(summary.key_guidance || []).map((item, index) => `${index + 1}. ${item}`),
    "",
    "Mentor connection",
    summary.mentor_connection,
    "",
    "Event to explore",
    summary.recommended_event,
    "",
    "Resource",
    summary.recommended_resource,
    "",
    "Your confirmed next step",
    `${summary.next_step.action} by ${summary.next_step.target_date}.`,
    `Owner: ${summary.next_step.owner}`,
    "",
    "Keep going. Pierce will help you stay connected to the next step in your journey.",
    "",
    "Pierce"
  ].join("\n");
}

const quickStartResources = {
  career_one_stop: { name: "CareerOneStop", url: "https://www.careeronestop.org/" },
  my_next_move: { name: "My Next Move", url: "https://www.mynextmove.org/" },
  onet_online: { name: "O*NET OnLine", url: "https://www.onetonline.org/" },
  sbcs: { name: "SBCS", url: "https://sbcssandiego.org/" },
  climb_hire_san_diego: {
    name: "Climb Hire San Diego",
    url: "https://climbhire.co/job-training-programs-san-diego/"
  },
  sdsu_careers: { name: "SDSU Careers", url: "https://careers.sdsu.edu/" },
  irc_san_diego: {
    name: "International Rescue Committee San Diego",
    url: "https://www.rescue.org/united-states/san-diego-ca"
  }
};

function quickStartEmailBody(record) {
  const lines = [
    `Hi ${firstName(record.participant.name)},`, "",
    `Here is your quick start from ${record.event.name}.`, "",
    "Career interest", record.job_interest, "",
    "Strength or experience", record.strength_or_experience, "",
    "A useful question for employers", record.employer_question, "",
    "Resource", `${record.resource.name}: ${record.resource.url}`, ""
  ];
  if (record.event.slug === "logan-heights-job-fair") {
    lines.push(
      "More San Diego career resources",
      "Climb Hire San Diego: https://climbhire.co/job-training-programs-san-diego/",
      "SBCS: https://sbcssandiego.org/",
      "SDSU Careers: https://careers.sdsu.edu/",
      "International Rescue Committee San Diego: https://www.rescue.org/united-states/san-diego-ca",
      "Logan Heights CDC: https://www.loganheightscdc.org/",
      "San Diego Workforce Partnership: https://workforce.org/",
      "UC San Diego Extended Studies & Google Career Certificates: https://www.workforce.org/about-google-meta/",
      "Program eligibility and availability vary. Review each program's requirements before applying.", ""
    );
  }
  lines.push(
    "Your next step", `${record.next_step.action} by ${record.next_step.target_date}.`, "",
    "You have a clear question and a practical next step. Keep going.", "", "Pierce"
  );
  return lines.join("\n");
}

function quickStartTakeaway(record) {
  return {
    kind: "summary",
    eyebrow: "YOUR JOB FAIR QUICK START",
    title: "Ready to speak with employers",
    description: `Your practical takeaway from ${record.event.name}.`,
    email_title: "Email this summary",
    email_description: "Receive one email with your question, resource, and next step.",
    items: [
      { label: "Career interest", title: record.job_interest },
      { label: "Strength to mention", title: record.strength_or_experience },
      { label: "Question to ask employers", title: record.employer_question },
      { label: "Resource", title: record.resource.name, url: record.resource.url },
      { label: "Next step", title: record.next_step.action, meta: `By ${record.next_step.target_date}` }
    ]
  };
}

function participantPreparationBody(record) {
  return [
    `Hi ${firstName(record.participant.name)},`,
    "",
    `Here is your preparation summary for ${record.event.name}.`,
    "",
    `Career goal: ${record.career_goal}`,
    `Current stage: ${record.career_stage}`,
    `Primary challenge: ${record.primary_challenge}`,
    "",
    "Questions for mentors",
    ...record.mentor_questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    "Pierce"
  ].join("\n");
}

function participantPreparationTakeaway(record) {
  return {
    kind: "summary",
    eyebrow: "YOUR EVENT PREPARATION",
    title: `Prepared for ${record.event.name}`,
    description: "Your goals and mentor questions are ready for the event.",
    email_title: "Email this summary",
    email_description: "Receive one email with your preparation notes.",
    items: [
      { label: "Career goal", title: record.career_goal },
      { label: "Current stage", title: record.career_stage },
      { label: "Primary challenge", title: record.primary_challenge },
      ...record.mentor_questions.map((question, index) => ({
        label: `Mentor question ${index + 1}`,
        title: question
      }))
    ]
  };
}

function mentorPreparationBody(record) {
  return [
    `Hi ${firstName(record.mentor.name)},`,
    "",
    `Here is your mentor preparation summary for ${record.event.name}.`,
    "",
    `Experience: ${record.expertise}`,
    `Support offered: ${record.support_offered}`,
    record.resource_offered ? `Optional resource: ${record.resource_offered}` : "",
    "",
    "Thank you for supporting participants.",
    "",
    "Pierce"
  ].filter(Boolean).join("\n");
}

function mentorPreparationTakeaway(record) {
  const items = [
    { label: "Experience", title: record.expertise },
    { label: "Support offered", title: record.support_offered }
  ];
  if (record.resource_offered) {
    items.push({ label: "Optional resource", title: record.resource_offered });
  }
  return {
    kind: "summary",
    eyebrow: "YOUR MENTOR PREPARATION",
    title: `Prepared for ${record.event.name}`,
    description: "Your mentor focus is ready for the event.",
    email_title: "Email this summary",
    email_description: "Receive one email with your mentor preparation notes.",
    items
  };
}

function checkInBody(record) {
  return [
    `Hi ${firstName(record.participant.name)},`,
    "",
    `You are checked in for ${record.event.name}.`,
    `Career goal: ${record.career_goal}`,
    "",
    "A mentor will welcome you shortly.",
    "",
    "Pierce"
  ].join("\n");
}

function checkInTakeaway(record) {
  return {
    kind: "summary",
    eyebrow: "CHECK-IN COMPLETE",
    title: `Welcome to ${record.event.name}`,
    description: "A mentor will welcome you shortly.",
    email_title: "Email this check-in",
    email_description: "Receive one email with this check-in confirmation.",
    items: [
      { label: "Participant", title: record.participant.name },
      { label: "Career goal", title: record.career_goal }
    ]
  };
}

function eventSummaryTakeaway(record) {
  return {
    kind: "summary",
    eyebrow: "YOUR SESSION RECAP",
    title: `Next steps from ${record.event.name}`,
    description: "Saved for organizer review before any approved email is sent.",
    email_title: "Email pending review",
    email_description: "The organizer will review this recap before delivery.",
    items: [
      ...record.key_guidance.map((guidance, index) => ({
        label: `Guidance ${index + 1}`,
        title: guidance
      })),
      { label: "Mentor connection", title: record.mentor_connection },
      { label: "Event to explore", title: record.recommended_event },
      { label: "Resource", title: record.recommended_resource },
      {
        label: "Next step",
        title: record.next_step.action,
        meta: `${record.next_step.owner} · By ${record.next_step.target_date}`
      }
    ]
  };
}

async function jobFairQuickStart(request, env) {
  const body = await requestJson(request);
  const event = configuredEvent(env, body.event_slug);
  const sourceId = String(body.source_id || "").trim();
  const emailConsent = body.email_consent === true;
  const participant = {
    name: normalizeGuestName(body.guest_name),
    email: emailConsent ? normalizeSpokenEmail(body.guest_email) : "",
    phone: normalizePhoneNumber(body.phone)
  };
  const resource = quickStartResources[String(body.resource_key || "").trim()];
  const targetDate = String(body.next_step_target_date || "").trim();
  if (!["job_fair_quick_start", "career_quick_start"].includes(event?.experience) || !participant.name ||
      body.recording_consent !== true || body.participant_approved !== true ||
      typeof body.email_consent !== "boolean" ||
      (emailConsent && (!isEmail(participant.email) || body.email_confirmed !== true)) ||
      !String(body.job_interest || "").trim() || !String(body.strength_or_experience || "").trim() ||
      !String(body.immediate_challenge || "").trim() || !String(body.employer_question || "").trim() ||
      !resource || !String(body.next_step || "").trim() || !isIsoDate(targetDate)) {
    return json({ ok: false, reason: "incomplete_job_fair_quick_start" }, 400);
  }
  if (sourceId) {
    const { rows } = await readObject(env.PIERCE_DATA, JOB_FAIR_QUICK_STARTS_KEY);
    const existing = rows.find((row) => row.source_id === sourceId);
    if (existing) {
      const delivery = body.delivery_mode === "guest_takeaway"
        ? await createGuestTakeaway(env, {
            kind: "job_fair_quick_start",
            subject: `Your ${existing.event.name} quick start`,
            body: quickStartEmailBody(existing)
          })
        : { delivery_id: "", email_available: false };
      return json({
        ok: true,
        duplicate: true,
        quick_start_id: existing.quick_start_id,
        participant_name: existing.participant?.name || participant.name,
        resource: existing.resource,
        next_step: existing.next_step,
        email_status: existing.email_status || "queued",
        takeaway: quickStartTakeaway(existing),
        ...delivery
      });
    }
  }
  const record = {
    quick_start_id: recordId("JFQ"), created_at: new Date().toISOString(),
    queue_type: "job_fair_quick_start", status: "complete", event: { ...event }, participant,
    source_id: sourceId,
    job_interest: String(body.job_interest).trim(),
    strength_or_experience: String(body.strength_or_experience).trim(),
    immediate_challenge: String(body.immediate_challenge).trim(),
    employer_question: String(body.employer_question).trim(),
    resource: { key: String(body.resource_key).trim(), ...resource },
    next_step: { action: String(body.next_step).trim(), target_date: targetDate },
    recording_consent: true, participant_approved: true,
    email_consent: emailConsent, email_confirmed: emailConsent
  };
  let emailStatus = "not_requested";
  if (emailConsent) {
    try {
      await sendGmail(env, { to: participant.email, subject: `Your ${event.name} quick start`, body: quickStartEmailBody(record) });
      emailStatus = "sent";
    } catch {
      emailStatus = "queued";
    }
  }
  record.email_status = emailStatus;
  await mutateJsonLines(env.PIERCE_DATA, JOB_FAIR_QUICK_STARTS_KEY, () => record);
  const hubspotSync = await queueHubspotSync(env, "job_fair_quick_start", record);
  const delivery = body.delivery_mode === "guest_takeaway"
    ? await createGuestTakeaway(env, {
        kind: "job_fair_quick_start",
        subject: `Your ${event.name} quick start`,
        body: quickStartEmailBody(record)
      })
    : { delivery_id: "", email_available: false };
  return json({ ok: true, quick_start_id: record.quick_start_id, participant_name: participant.name,
    resource: record.resource, next_step: record.next_step, email_status: emailStatus,
    takeaway: quickStartTakeaway(record), ...delivery, hubspot_sync: hubspotSync });
}

async function participantIntake(request, env) {
  const body = await requestJson(request);
  const event = configuredEvent(env, body.event_slug);
  const participant = {
    name: normalizeGuestName(body.guest_name),
    email: normalizeSpokenEmail(body.guest_email)
  };
  const mentorQuestions = normalizeStringList(body.mentor_questions, 2);
  if (!event || !participant.name || !isEmail(participant.email) || body.email_confirmed !== true ||
      body.recording_consent !== true || typeof body.information_sharing_consent !== "boolean" ||
      !String(body.guest_city || "").trim() || !String(body.career_stage || "").trim() ||
      !String(body.career_goal || "").trim() || !String(body.primary_challenge || "").trim() ||
      mentorQuestions.length !== 2) {
    return json({ ok: false, reason: "incomplete_event_intake" }, 400);
  }

  const saved = await mutateJsonLines(env.PIERCE_DATA, EVENT_INTAKES_KEY, (rows) => {
    const existing = rows.find((row) => row.role === "participant" && row.event?.slug === event.slug &&
      emailIdentityKey(row.participant?.email) === emailIdentityKey(participant.email));
    if (existing) return json({ ok: true, duplicate: true, intake_id: existing.intake_id,
      participant_name: existing.participant.name, event: existing.event,
      mentor_briefing_allowed: existing.information_sharing_consent,
      hubspot_sync: skippedHubSpot() });
    return {
      intake_id: recordId("EVP"), created_at: new Date().toISOString(),
      queue_type: "event_participant_intake", role: "participant", status: "prepared",
      event: { ...event }, participant, guest_city: String(body.guest_city).trim(),
      career_stage: String(body.career_stage).trim(), career_goal: String(body.career_goal).trim(),
      primary_challenge: String(body.primary_challenge).trim(), mentor_questions: mentorQuestions,
      resume_url: String(body.resume_url || "").trim(), recording_consent: true,
      information_sharing_consent: body.information_sharing_consent, email_confirmed: true
    };
  });
  if (saved instanceof Response) return saved;
  const hubspotSync = await queueHubspotSync(env, "event_participant_intake", saved);
  const delivery = body.delivery_mode === "guest_takeaway"
    ? await createGuestTakeaway(env, {
        kind: "event_participant_preparation",
        subject: `Your preparation for ${saved.event.name}`,
        body: participantPreparationBody(saved)
      })
    : { delivery_id: "", email_available: false };
  return json({ ok: true, intake_id: saved.intake_id, participant_name: participant.name,
    event: saved.event, mentor_briefing_allowed: saved.information_sharing_consent,
    takeaway: participantPreparationTakeaway(saved), ...delivery, hubspot_sync: hubspotSync });
}

async function mentorIntake(request, env) {
  const body = await requestJson(request);
  const event = configuredEvent(env, body.event_slug);
  const mentor = { name: normalizeGuestName(body.mentor_name), email: normalizeSpokenEmail(body.mentor_email) };
  if (!event || !mentor.name || !isEmail(mentor.email) || body.email_confirmed !== true ||
      body.recording_consent !== true || !String(body.expertise || "").trim() ||
      !String(body.support_offered || "").trim()) {
    return json({ ok: false, reason: "incomplete_mentor_intake" }, 400);
  }
  const saved = await mutateJsonLines(env.PIERCE_DATA, EVENT_INTAKES_KEY, (rows) => {
    const existing = rows.find((row) => row.role === "mentor" && row.event?.slug === event.slug &&
      emailIdentityKey(row.mentor?.email) === emailIdentityKey(mentor.email));
    if (existing) return json({ ok: true, duplicate: true, intake_id: existing.intake_id,
      mentor_name: existing.mentor.name, event: existing.event, hubspot_sync: skippedHubSpot() });
    return {
      intake_id: recordId("EVM"), created_at: new Date().toISOString(),
      queue_type: "event_mentor_intake", role: "mentor", status: "prepared",
      event: { ...event }, mentor, expertise: String(body.expertise).trim(),
      support_offered: String(body.support_offered).trim(),
      resource_offered: String(body.resource_offered || "").trim(),
      recording_consent: true, email_confirmed: true
    };
  });
  if (saved instanceof Response) return saved;
  const hubspotSync = await queueHubspotSync(env, "event_mentor_intake", saved);
  const delivery = body.delivery_mode === "guest_takeaway"
    ? await createGuestTakeaway(env, {
        kind: "event_mentor_preparation",
        subject: `Your mentor preparation for ${saved.event.name}`,
        body: mentorPreparationBody(saved)
      })
    : { delivery_id: "", email_available: false };
  return json({ ok: true, intake_id: saved.intake_id, mentor_name: mentor.name,
    event: saved.event, takeaway: mentorPreparationTakeaway(saved), ...delivery,
    hubspot_sync: hubspotSync });
}

async function participantLookup(request, env) {
  const body = await requestJson(request);
  const event = configuredEvent(env, body.event_slug);
  const targetKey = nameKey(body.guest_name);
  if (!event || !targetKey) return json({ ok: false, reason: "missing_event_or_name" }, 400);
  const { rows } = await readObject(env.PIERCE_DATA, EVENT_INTAKES_KEY);
  const matches = rows.filter((row) => row.role === "participant" && row.event?.slug === event.slug)
    .filter((row) => {
      const candidate = nameKey(row.participant?.name);
      return candidate === targetKey || candidate.includes(targetKey) || targetKey.includes(candidate);
    }).slice(-4).map((row) => ({ intake_id: row.intake_id, participant_name: row.participant.name,
      career_goal: row.career_goal, career_stage: row.career_stage, guest_city: row.guest_city }));
  return json({ ok: true, event: { ...event }, match_count: matches.length, matches });
}

async function eventCheckIn(request, env) {
  const body = await requestJson(request);
  const event = configuredEvent(env, body.event_slug);
  const intakeId = String(body.intake_id || "").trim();
  if (!event || !intakeId || body.recording_consent !== true) {
    return json({ ok: false, reason: "incomplete_event_check_in" }, 400);
  }
  const { rows: intakes } = await readObject(env.PIERCE_DATA, EVENT_INTAKES_KEY);
  const intake = intakes.find((row) => row.intake_id === intakeId && row.role === "participant" && row.event?.slug === event.slug);
  if (!intake) return json({ ok: false, reason: "event_participant_not_found" }, 404);
  const saved = await mutateJsonLines(env.PIERCE_DATA, EVENT_CHECK_INS_KEY, (rows) => {
    const existing = rows.find((row) => row.intake_id === intakeId && row.event?.slug === event.slug);
    if (existing) return json({ ok: true, duplicate: true, check_in_id: existing.check_in_id,
      participant_name: existing.participant.name, career_goal: existing.career_goal,
      event: existing.event, hubspot_sync: skippedHubSpot() });
    const now = new Date().toISOString();
    return { check_in_id: recordId("EVC"), created_at: now, checked_in_at: now,
      queue_type: "event_check_in", status: "checked_in", event: { ...event },
      intake_id: intake.intake_id, participant: intake.participant,
      career_goal: intake.career_goal, recording_consent: true };
  });
  if (saved instanceof Response) return saved;
  const hubspotSync = await queueHubspotSync(env, "event_check_in", saved);
  const delivery = body.delivery_mode === "guest_takeaway"
    ? await createGuestTakeaway(env, {
        kind: "event_check_in",
        subject: `Your ${saved.event.name} check-in`,
        body: checkInBody(saved)
      })
    : { delivery_id: "", email_available: false };
  return json({ ok: true, check_in_id: saved.check_in_id, participant_name: saved.participant.name,
    career_goal: saved.career_goal, event: saved.event, takeaway: checkInTakeaway(saved),
    ...delivery, hubspot_sync: hubspotSync });
}

async function eventSummary(request, env) {
  const body = await requestJson(request);
  const event = configuredEvent(env, body.event_slug);
  const intakeId = String(body.intake_id || "").trim();
  const guidance = normalizeStringList(body.key_guidance, 2);
  const nextStep = { action: String(body.next_step || "").trim(),
    owner: String(body.next_step_owner || "").trim(),
    target_date: String(body.next_step_target_date || "").trim() };
  if (!event || !intakeId || guidance.length < 1 || !String(body.mentor_connection || "").trim() ||
      !String(body.recommended_event || "").trim() || !String(body.recommended_resource || "").trim() ||
      !nextStep.action || !nextStep.owner || !isIsoDate(nextStep.target_date) ||
      body.participant_approved !== true || body.recording_consent !== true ||
      typeof body.email_consent !== "boolean") {
    return json({ ok: false, reason: "incomplete_event_summary" }, 400);
  }
  const { rows: intakes } = await readObject(env.PIERCE_DATA, EVENT_INTAKES_KEY);
  const intake = intakes.find((row) => row.intake_id === intakeId && row.role === "participant" && row.event?.slug === event.slug);
  if (!intake) return json({ ok: false, reason: "event_participant_not_found" }, 404);
  const saved = await mutateJsonLines(env.PIERCE_DATA, EVENT_SUMMARIES_KEY, (rows) => {
    const existing = rows.find((row) => row.record_type === "summary" && row.intake_id === intakeId);
    if (existing) return json({ ok: true, duplicate: true, summary_id: existing.summary_id, status: existing.status });
    return { summary_id: recordId("EVS"), record_type: "summary", created_at: new Date().toISOString(),
      queue_type: "event_session_summary", status: "pending_organizer_review", event: { ...event },
      intake_id: intake.intake_id, participant: intake.participant, key_guidance: guidance,
      mentor_connection: String(body.mentor_connection).trim(), recommended_event: String(body.recommended_event).trim(),
      recommended_resource: String(body.recommended_resource).trim(), next_step: nextStep,
      participant_approved: true, recording_consent: true, email_consent: body.email_consent };
  });
  if (saved instanceof Response) return saved;
  return json({ ok: true, summary_id: saved.summary_id, status: saved.status,
    participant_name: saved.participant.name, next_step: saved.next_step,
    takeaway: eventSummaryTakeaway(saved), delivery_id: "", email_available: false });
}

async function eventReviewList(env, url) {
  const event = configuredEvent(env, url.searchParams.get("slug"));
  if (!event) return json({ ok: false, reason: "event_not_found" }, 404);
  const { rows } = await readObject(env.PIERCE_DATA, EVENT_SUMMARIES_KEY);
  const reviews = new Map();
  for (const row of rows) {
    if (row.record_type === "review" || row.record_type === "review_delivery") {
      reviews.set(row.summary_id, { ...(reviews.get(row.summary_id) || {}), ...row });
    }
  }
  const summaries = rows
    .filter((row) => row.record_type === "summary" && row.event?.slug === event.slug)
    .map((summary) => ({ ...summary, review: reviews.get(summary.summary_id) || null }));
  return json({ ok: true, event, summaries });
}

async function eventReviewApproval(request, env, organizerIdentity) {
  const body = await requestJson(request);
  const summaryId = String(body.summary_id || "").trim();
  if (!summaryId || body.approved !== true) return json({ ok: false, reason: "approval_required" }, 400);

  const { rows } = await readObject(env.PIERCE_DATA, EVENT_SUMMARIES_KEY);
  const summary = rows.find((row) => row.record_type === "summary" && row.summary_id === summaryId);
  if (!summary) return json({ ok: false, reason: "event_summary_not_found" }, 404);
  const priorReview = [...rows].reverse().find((row) =>
    (row.record_type === "review" || row.record_type === "review_delivery") && row.summary_id === summaryId);
  if (priorReview) return json({ ok: true, duplicate: true, ...priorReview, hubspot_sync: skippedHubSpot() });

  const approvedAt = new Date().toISOString();
  const claim = await mutateJsonLines(env.PIERCE_DATA, EVENT_SUMMARIES_KEY, (currentRows) => {
    const existing = [...currentRows].reverse().find((row) =>
      (row.record_type === "review" || row.record_type === "review_delivery") && row.summary_id === summaryId);
    if (existing) return json({ ok: true, duplicate: true, ...existing, hubspot_sync: skippedHubSpot() });
    return {
      record_type: "review",
      review_id: recordId("EVR"),
      summary_id: summaryId,
      approved_at: approvedAt,
      approved_by: organizerIdentity.email,
      status: summary.email_consent ? "approved_email_sending" : "approved",
      email_id: summary.email_consent ? recordId("EML") : "",
      email_sent: false,
      email_queued: false
    };
  });
  if (claim instanceof Response) return claim;

  let delivery = claim;
  if (summary.email_consent) {
    let result;
    try {
      if (!googleConfigured(env)) throw new GoogleApiError("google_not_connected", "Google is not connected.", 503);
      const sent = await sendGmail(env, {
        to: summary.participant.email,
        subject: `Your next steps from ${summary.event.name}`,
        body: eventFollowUpBody(summary)
      });
      result = { status: "approved", email_sent: true, email_queued: false,
        provider_message_id: sent.id || "", delivery_error: "" };
    } catch (error) {
      result = { status: "approved_email_pending", email_sent: false, email_queued: true,
        provider_message_id: "", delivery_error: error?.reason || "email_delivery_failed" };
    }
    delivery = await mutateJsonLines(env.PIERCE_DATA, EVENT_SUMMARIES_KEY, () => ({
      ...claim,
      ...result,
      record_type: "review_delivery",
      delivered_at: result.email_sent ? new Date().toISOString() : ""
    }));
  }

  const hubspotSync = await queueHubspotSync(env, "event_session_summary", {
    ...summary, approved_at: claim.approved_at
  });
  return json({ ok: true, ...delivery, hubspot_sync: hubspotSync });
}

export async function handleEventRoute(request, env, organizerIdentity = null) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/event/config") {
    const event = configuredEvent(env, url.searchParams.get("slug"));
    return event ? json({ ok: true, event }) : json({ ok: false, reason: "event_not_found" }, 404);
  }
  if (request.method === "GET" && url.pathname === "/event/review") {
    if (!organizerIdentity) return json({ ok: false, reason: "organizer_access_required" }, 403);
    if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
    return eventReviewList(env, url);
  }
  if (request.method === "POST" && url.pathname === "/event/review/approve") {
    if (!organizerIdentity) return json({ ok: false, reason: "organizer_access_required" }, 403);
    if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
    return eventReviewApproval(request, env, organizerIdentity);
  }
  if (request.method !== "POST") return null;
  const routes = new Set(["/event/intake/participant", "/event/intake/mentor",
    "/event/participant/lookup", "/event/check-in", "/event/summary",
    "/event/job-fair/complete", "/event/quick-start/complete"]);
  if (!routes.has(url.pathname)) return null;
  if (!env.PIERCE_DATA) return json({ ok: false, reason: "r2_not_configured" }, 503);
  if (url.pathname === "/event/intake/participant") return participantIntake(request, env);
  if (url.pathname === "/event/intake/mentor") return mentorIntake(request, env);
  if (url.pathname === "/event/participant/lookup") return participantLookup(request, env);
  if (url.pathname === "/event/check-in") return eventCheckIn(request, env);
  if (["/event/job-fair/complete", "/event/quick-start/complete"].includes(url.pathname)) {
    return jobFairQuickStart(request, env);
  }
  return eventSummary(request, env);
}
