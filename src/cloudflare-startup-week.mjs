import { createGuestTakeaway } from "./cloudflare-guest-takeaway.mjs";
import { startupWeekSchedule } from "./startup-week-schedule-2026.mjs";

const MAX_JSON_BYTES = 16 * 1024;
const DEFAULT_RESULT_LIMIT = 4;
const MIN_RESULT_LIMIT = 2;
const MAX_RESULT_LIMIT = 5;
const validDates = new Set(startupWeekSchedule.dates.map((day) => day.date));
const mentoringIntentPattern = /\b(advice|advisor|advising|mentor|mentoring)\b/;

const stopWords = new Set([
  "about", "after", "again", "also", "because", "been", "before", "being", "came",
  "come", "company", "could", "from", "have", "help", "into", "just", "learn", "learning", "like", "looking", "make",
  "more", "need", "really", "some", "startup", "that", "their", "there", "these", "they",
  "this", "through", "want", "week", "what", "when", "where", "which", "with", "would",
  "your"
]);

const topicGroups = [
  {
    label: "funding and investors",
    terms: ["fund", "funding", "fundraise", "fundraising", "raise", "raising", "investor", "investors", "venture", "capital", "angel", "finance", "financing", "pitch", "vc"]
  },
  {
    label: "AI and technology",
    terms: ["ai", "artificial intelligence", "technology", "software", "data", "automation", "technical", "cybersecurity", "security"]
  },
  {
    label: "marketing and growth",
    terms: ["advertising", "brand", "branding", "customer", "customers", "growth", "gtm", "go to market", "marketing", "sales", "story", "storytelling"]
  },
  {
    label: "launch and validation",
    terms: ["idea", "launch", "mvp", "product", "prototype", "validation", "validate", "product market fit", "incubator", "accelerator"]
  },
  {
    label: "mentoring and connections",
    terms: ["advice", "advisor", "advising", "community", "connect", "connection", "mentor", "mentoring", "network", "networking", "people"]
  },
  {
    label: "leadership and teams",
    terms: ["culture", "founder", "founders", "hire", "hiring", "leadership", "operations", "team", "teams", "talent"]
  },
  {
    label: "legal and business setup",
    terms: ["contract", "contracts", "incorporate", "incorporation", "legal", "license", "licensing", "structure"]
  },
  {
    label: "health and life sciences",
    terms: ["biotech", "health", "healthcare", "healthtech", "life science", "life sciences", "medical", "science"]
  },
  {
    label: "career and skill building",
    terms: ["career", "job", "jobs", "skill", "skills", "student", "workshop"]
  },
  {
    label: "social impact",
    terms: ["community impact", "nonprofit", "purpose", "social impact", "sustainability"]
  }
];

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

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function goalTokens(goal) {
  return [...new Set(normalize(goal).split(" "))]
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

function matchingTopics(goal, title, description) {
  const normalizedGoal = normalize(goal);
  return topicGroups.flatMap((group) => {
    const goalMatches = group.terms.some((term) => normalizedGoal.includes(normalize(term)));
    const titleMatches = group.terms.some((term) => title.includes(normalize(term)));
    const descriptionMatches = group.terms.some((term) => description.includes(normalize(term)));
    return goalMatches && (titleMatches || descriptionMatches)
      ? [{ ...group, title_match: titleMatches }]
      : [];
  });
}

function hasMentoringIntent(goal) {
  return mentoringIntentPattern.test(normalize(goal));
}

function scoreEvent(event, goal) {
  const title = normalize(event.title);
  const description = normalize(event.description);
  const tokens = goalTokens(goal);
  const matchedTokens = [];
  const directMentoringMatch = hasMentoringIntent(goal) && title.includes("speed mentoring");
  let score = 0;

  for (const token of tokens) {
    if (title.includes(token)) {
      score += 8;
      matchedTokens.push(token);
    } else if (description.includes(token)) {
      score += 3;
      matchedTokens.push(token);
    }
  }

  const topics = matchingTopics(goal, title, `${description} ${normalize(event.category)}`);
  score += topics.reduce((total, topic) => total + (topic.title_match ? 18 : 10), 0);
  if (directMentoringMatch) score += 60;
  if (event.official) score += 1.5;
  if (event.featured) score += 1.5;
  if (/\bcheck in\b/.test(title)) score -= 24;
  if (/\bexpo\b/.test(title) && topics.length === 0 && matchedTokens.length === 0) score -= 2;

  return {
    event,
    score,
    topics,
    matchedTokens: [...new Set(matchedTokens)],
    directMentoringMatch
  };
}

function overlaps(left, right) {
  return left.date === right.date &&
    left.start_minute < right.end_minute && right.start_minute < left.end_minute;
}

function reasonFor(scored) {
  if (scored.directMentoringMatch) {
    return "Directly matches your request for mentoring in Carlsbad.";
  }
  const labels = scored.topics.map((topic) => topic.label).slice(0, 2);
  if (labels.length) return `Matches your interest in ${labels.join(" and ")}.`;
  const terms = scored.matchedTokens.slice(0, 3);
  if (terms.length) return `Connects directly to ${terms.join(", ")}.`;
  if (scored.event.featured) return "A featured session that can add a useful perspective to your week.";
  return "A practical session that can broaden your Startup Week connections and ideas.";
}

function publicEvent(scored) {
  const event = scored.event;
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    date_label: event.date_label,
    start: event.start,
    end: event.end,
    venue: event.venue,
    room: event.room,
    address: event.address,
    description: event.description,
    reason: reasonFor(scored),
    event_url: event.event_url,
    registration_url: event.registration_url,
    official: event.official,
    featured: event.featured
  };
}

function startupWeekEmailBody(delivery) {
  const lines = [
    "Here is the San Diego Startup Week shortlist you asked Pierce to email.",
    ""
  ];
  delivery.recommendations.forEach((event, index) => {
    const time = event.end ? `${event.start}–${event.end}` : event.start;
    lines.push(
      `${index + 1}. ${event.title}`,
      [event.date_label, time].filter(Boolean).join(" · "),
      event.venue ? `Location: ${event.venue}` : "",
      `Why it fits: ${event.reason}`,
      `Official event page: ${event.event_url}`,
      ""
    );
  });
  lines.push(
    `Confirm last-minute changes on the official schedule: ${startupWeekSchedule.source_url}`,
    "",
    "You requested this one-time event-list email from Pierce. This is not a subscription or marketing message.",
    "",
    "Pierce"
  );
  return lines.filter((line, index, all) => line || all[index - 1]).join("\n");
}

export function recommendStartupWeekEvents({ goal, available_dates = [], limit } = {}) {
  const cleanGoal = String(goal || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  if (cleanGoal.length < 3) {
    return { ok: false, reason: "guest_goal_required" };
  }

  const requestedDates = Array.isArray(available_dates)
    ? [...new Set(available_dates.map((date) => String(date || "").trim()).filter(Boolean))]
    : [];
  if (requestedDates.some((date) => !validDates.has(date))) {
    return { ok: false, reason: "invalid_startup_week_date" };
  }

  const resultLimit = Math.max(
    MIN_RESULT_LIMIT,
    Math.min(MAX_RESULT_LIMIT, Number.isInteger(limit) ? limit : DEFAULT_RESULT_LIMIT)
  );
  const candidates = startupWeekSchedule.events
    .filter((event) => requestedDates.length === 0 || requestedDates.includes(event.date))
    .map((event) => scoreEvent(event, cleanGoal))
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.event.official) - Number(left.event.official) ||
      Number(right.event.featured) - Number(left.event.featured) ||
      left.event.date.localeCompare(right.event.date) ||
      left.event.start_minute - right.event.start_minute
    );

  const selected = [];
  const usedTitles = new Set();
  for (const candidate of candidates) {
    const titleKey = normalize(candidate.event.title);
    if (usedTitles.has(titleKey)) continue;
    if (selected.some((picked) => overlaps(picked.event, candidate.event))) continue;
    if (requestedDates.length === 0) {
      const sameDayCount = selected.filter((picked) => picked.event.date === candidate.event.date).length;
      if (sameDayCount >= 2) continue;
    }
    selected.push(candidate);
    usedTitles.add(titleKey);
    if (selected.length >= resultLimit) break;
  }

  if (selected.length < resultLimit) {
    for (const candidate of candidates) {
      const titleKey = normalize(candidate.event.title);
      if (usedTitles.has(titleKey)) continue;
      selected.push(candidate);
      usedTitles.add(titleKey);
      if (selected.length >= resultLimit) break;
    }
  }

  return {
    ok: true,
    guest_goal: cleanGoal,
    available_dates: requestedDates,
    recommendations: selected.map(publicEvent),
    schedule: {
      name: startupWeekSchedule.name,
      source_url: startupWeekSchedule.source_url,
      retrieved_at: startupWeekSchedule.retrieved_at,
      event_count: startupWeekSchedule.events.length
    }
  };
}

export async function handleStartupWeekRoute(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/startup-week/schedule") {
    return json({
      ok: true,
      schedule: {
        name: startupWeekSchedule.name,
        source_url: startupWeekSchedule.source_url,
        retrieved_at: startupWeekSchedule.retrieved_at,
        dates: startupWeekSchedule.dates,
        event_count: startupWeekSchedule.events.length
      }
    });
  }
  if (request.method !== "POST" || url.pathname !== "/startup-week/recommend") return null;
  try {
    const result = recommendStartupWeekEvents(await requestJson(request));
    if (!result.ok) return json(result, 400);
    Object.assign(result, await createGuestTakeaway(env, {
      kind: "startup_week_shortlist",
      subject: "Your San Diego Startup Week event list",
      body: startupWeekEmailBody(result)
    }));
    return json(result);
  } catch (error) {
    if (error instanceof RangeError) return json({ ok: false, reason: "request_too_large" }, 413);
    if (error instanceof SyntaxError) return json({ ok: false, reason: "invalid_json" }, 400);
    throw error;
  }
}
