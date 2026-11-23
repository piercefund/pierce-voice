import { getOnetOccupationOverview, searchOnetOccupations } from "./cloudflare-onet.mjs";
import { PIERCE_APPROVED_RESOURCES, publicResource } from "./pierce-approved-resources.mjs";

const ONET_ROUTE = "/tools/lookup-onet-career";
const RESOURCE_ROUTE = "/tools/lookup-resource-directory";
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

function resourceScore(resource, query, location) {
  const queryWords = words(query);
  const searchable = [resource.name, resource.description, ...resource.categories].join(" ");
  let score = overlapScore(queryWords, searchable) * 4;
  const normalizedQuery = query.toLowerCase();
  for (const category of resource.categories) {
    if (normalizedQuery.includes(category.toLowerCase())) score += 6;
  }
  if (location) {
    const normalizedLocation = location.toLowerCase();
    if (resource.locations.some((item) => normalizedLocation.includes(item) || item.includes(normalizedLocation))) {
      score += 5;
    } else if (!resource.locations.includes("online")) {
      score -= 2;
    }
  }
  return score;
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
  const ranked = Object.keys(PIERCE_APPROVED_RESOURCES)
    .map((key) => ({ resource: publicResource(key), score: resourceScore(PIERCE_APPROVED_RESOURCES[key], query, location) }))
    .sort((left, right) => right.score - left.score || left.resource.name.localeCompare(right.resource.name));
  const positive = ranked.filter((item) => item.score > 0);
  const selected = (positive.length ? positive : ranked).slice(0, limit).map((item) => item.resource);
  return response({
    ok: true,
    query,
    location,
    results: selected,
    instruction: "Recommend only a returned resource. Repeat its eligibility note when present."
  });
}

export async function handleElevenLabsToolRoute(request, env, fetchImpl = fetch) {
  const pathname = new URL(request.url).pathname;
  if (![ONET_ROUTE, RESOURCE_ROUTE].includes(pathname)) return null;
  if (request.method !== "POST") return response({ ok: false, error: "Method not allowed." }, 405);
  if (!(await authenticated(request, env))) return response({ ok: false, error: "Unauthorized." }, 401);

  try {
    const body = await readJson(request);
    if (pathname === ONET_ROUTE) return await lookupOnet(body, env, fetchImpl);
    return lookupResources(body);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
      return response({ ok: false, error: "Invalid tool request." }, 400);
    }
    return response({ ok: false, error: "The lookup is temporarily unavailable." }, 502);
  }
}

export const ELEVENLABS_TOOL_ROUTES = Object.freeze({
  lookup_onet_career: ONET_ROUTE,
  lookup_resource_directory: RESOURCE_ROUTE
});
