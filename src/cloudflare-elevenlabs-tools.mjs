import { formatCareerRecap } from "./pierce-career-recap-email.mjs";
import { getOnetOccupationOverview, searchOnetOccupations } from "./cloudflare-onet.mjs";
import { sendGmail } from "./cloudflare-google-api.mjs";
import { createGuestTakeaway, emailGuestTakeaway } from "./cloudflare-guest-takeaway.mjs";
import { PIERCE_APPROVED_RESOURCES, publicResource } from "./pierce-approved-resources.mjs";

const ONET_ROUTE = "/tools/lookup-onet-career";
const RESOURCE_ROUTE = "/tools/lookup-resource-directory";
const TEST_RECAP_ROUTE = "/tools/send-test-recap";
const GUEST_RECAP_ROUTE = "/tools/prepare-guest-recap";
const VOICE_RECAP_ROUTE = "/tools/send-voice-recap";
const WEB_RECAP_KIND = "elevenlabs_web_recap";
const TEST_RECAP_RECIPIENT = "voice@pierce.fund";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESULTS = 5;

function response(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

async function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function authenticated(request, env) {
  const secret = env.ELEVENLABS_TOOL_BEARER_TOKEN || env.ELEVENLABS_LLM_BEARER_TOKEN;
  if (typeof secret !== "string" || secret.length < 32) return false;
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  return constantTimeEqual(authorization.slice(7), secret);
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RangeError("request_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RangeError("request_too_large");
  }
  const body = JSON.parse(text || "{}");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("invalid_body");
  return body;
}

function boundedText(value, maxLength, required = false) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if ((required && text.length < 2) || text.length > maxLength) throw new TypeError("invalid_input");
  return text;
}

function boundedLimit(value, fallback = 3) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_RESULTS) {
    throw new TypeError("invalid_limit");
  }
  return number;
}

function words(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9]+/g) || []);
}

function overlapScore(queryWords, value) {
  const candidateWords = words(value);
  let score = 0;
  for (const word of queryWords) if (candidateWords.has(word)) score += 1;
  return score;
}

function normalizedPhrase(value) {
  return [...value.toLowerCase().matchAll(/[a-z0-9]+/g)].map(([word]) => word).join(" ");
}

function matchLocalProgram(resource, query, location) {
  const region = normalizedPhrase(location);
  const californiaSuffix = /(?:^| )(?:ca|california)(?: (?:us|usa|united states))?$/;
  const city = region.replace(californiaSuffix, "");
  if (!resource.serviceArea.includes(city) && !(resource.statewideCalifornia && californiaSuffix.test(region))) {
    return null;
  }
  const phrase = ` ${normalizedPhrase(query)} `;
  return resource.programs.find(({ keywords }) =>
    keywords.some((word) => phrase.includes(` ${word} `))
  );
}

async function lookupOnet(body, env, fetchImpl) {
  if (!env.ONET_API_KEY) return response({ ok: false, error: "O*NET lookup is unavailable." }, 503);
  const query = boundedText(body.query, 100, true);
  const limit = boundedLimit(body.limit);
  const matches = await searchOnetOccupations(query, env.ONET_API_KEY, fetchImpl, limit);
  const results = await Promise.all(matches.map(async (match) => {
    try {
      return await getOnetOccupationOverview(match.code, env.ONET_API_KEY, fetchImpl);
    } catch {
      return match;
    }
  }));
  return response({
    ok: true,
    source: "O*NET Web Services by the U.S. Department of Labor, Employment and Training Administration",
    query,
    results
  });
}

function lookupResources(body) {
  const query = boundedText(body.query, 200, true);
  const location = boundedText(body.location, 100);
  const limit = boundedLimit(body.limit);
  const queryWords = words(query);
  const ranked = Object.entries(PIERCE_APPROVED_RESOURCES).flatMap(([key, resource]) => {
    if (resource.serviceArea) {
      const program = matchLocalProgram(resource, query, location);
      if (!program) return [];
      const { name, url, note } = program;
      const specific = program.keywords.some((keyword) =>
        keyword.includes(" ") && ` ${normalizedPhrase(query)} `.includes(` ${keyword} `)
      );
      return [{ resource: { ...publicResource(key), program: { name, url, note }, fit: "local" }, score: specific ? 110 : 100 }];
    }
    const searchable = [resource.name, resource.description, ...resource.categories].join(" ");
    return [{ resource: { ...publicResource(key), fit: "national" }, score: overlapScore(queryWords, searchable) }];
  }).sort((left, right) => right.score - left.score || left.resource.name.localeCompare(right.resource.name));
  const selected = ranked.slice(0, limit).map(({ resource }) => resource);
  return response({
    ok: true,
    query,
    location,
    results: selected,
    instruction: "Prioritize a returned local program that fits the stated need. Share the program note and preserve the exact provider name in recaps. Confirm current intake and eligibility with the provider. If location is missing, ask for city and state in one question only when it would improve the recommendation. Continue with national options if the guest declines."
  });
}

export async function handleElevenLabsToolRoute(request, env, fetchImpl = fetch) {
  const pathname = new URL(request.url).pathname;
  if (![ONET_ROUTE, RESOURCE_ROUTE, TEST_RECAP_ROUTE, GUEST_RECAP_ROUTE, VOICE_RECAP_ROUTE].includes(pathname)) return null;
  if (request.method !== "POST") return response({ ok: false, error: "Method not allowed." }, 405);
  if (!(await authenticated(request, env))) return response({ ok: false, error: "Unauthorized." }, 401);

  try {
    const body = await readJson(request);
    if (pathname === VOICE_RECAP_ROUTE) {
      if (body.email_confirmed !== true || body.email_consent !== true) {
        return response({ ok: false, error: "Email consent and address confirmation are required." }, 400);
      }
      return await emailGuestTakeaway({
        delivery_id: body.delivery_id,
        guest_email: body.email,
        email_consent: true
      }, env, { requiredKind: WEB_RECAP_KIND });
    }
    if (pathname === GUEST_RECAP_ROUTE) {
      if (body.email_consent !== true) {
        return response({ ok: false, error: "Email consent is required." }, 400);
      }
      const fields = [
        ["Career goal", boundedText(body.career_goal, 240, true)],
        ["Strength", boundedText(body.strength, 240)],
        ["Guidance", boundedText(body.guidance, 450, true)],
        ["Next step", boundedText(body.next_step, 280, true)]
      ];
      const recap = await createGuestTakeaway(env, {
        kind: WEB_RECAP_KIND,
        subject: "Your Pierce career session recap",
        ...formatCareerRecap(fields.filter(([, value]) => value))
      });
      if (!recap.email_available) return response({ ok: false, error: "Recap delivery is unavailable." }, 503);
      const link = new URL("/recap-email.html", request.url);
      link.hash = recap.delivery_id;
      return response({ ok: true, delivery_id: recap.delivery_id, delivery_url: link.href });
    }
    if (pathname === TEST_RECAP_ROUTE) {
      if (env.PIERCE_TEST_RECAP_ENABLED !== "true") {
        return response({ ok: false, error: "Test delivery is unavailable." }, 503);
      }
      if (
        body.email_consent !== true || body.email_confirmed !== true ||
        typeof body.email !== "string" || body.email.trim().toLowerCase() !== TEST_RECAP_RECIPIENT
      ) {
        return response({ ok: false, error: "The test address or confirmation is invalid." }, 400);
      }
      await sendGmail(env, {
        to: TEST_RECAP_RECIPIENT,
        subject: "Pierce Voice — test recap",
        body: "This is a fictional Pierce Voice recap.\n\nGoal: Explore a career in architecture.\nNext step: Compare architecture programs and write down one question to ask an admissions adviser."
      });
      return response({ ok: true, sent: true });
    }
    if (pathname === ONET_ROUTE) return await lookupOnet(body, env, fetchImpl);
    return lookupResources(body);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
      return response({ ok: false, error: "Invalid tool request." }, 400);
    }
    return response({ ok: false, error: "The tool is temporarily unavailable." }, 502);
  }
}

export const ELEVENLABS_TOOL_ROUTES = Object.freeze({
  lookup_onet_career: ONET_ROUTE,
  lookup_resource_directory: RESOURCE_ROUTE,
  send_test_recap: TEST_RECAP_ROUTE,
  prepare_guest_recap: GUEST_RECAP_ROUTE,
  send_voice_recap: VOICE_RECAP_ROUTE
});
