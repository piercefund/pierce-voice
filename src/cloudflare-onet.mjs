const ONET_API_BASE = "https://api-v2.onetcenter.org";
const ONET_CODE = /^\d{2}-\d{4}\.\d{2}$/;

function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "public, max-age=3600, s-maxage=86400");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function onetFetch(path, apiKey, fetchImpl = fetch) {
  const request = () => fetchImpl(`${ONET_API_BASE}${path}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": apiKey
    }
  });

  let response = await request();
  if (response.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await request();
  }
  if (!response.ok) {
    const error = new Error(`O*NET request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function searchOnetOccupations(query, apiKey, fetchImpl = fetch, limit = 5) {
  const normalizedQuery = String(query || "").trim();
  if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
    throw new TypeError("invalid_search");
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 5);
  const data = await onetFetch(
    `/online/search?keyword=${encodeURIComponent(normalizedQuery)}&start=1&end=${safeLimit}`,
    apiKey,
    fetchImpl
  );
  return (Array.isArray(data?.occupation) ? data.occupation : []).map((item) => ({
    code: String(item?.code || ""),
    title: String(item?.title || ""),
    brightOutlook: Boolean(item?.tags?.bright_outlook),
    sourceUrl: `https://www.onetonline.org/link/summary/${encodeURIComponent(String(item?.code || ""))}`
  })).filter((item) => ONET_CODE.test(item.code) && item.title).slice(0, safeLimit);
}

export async function getOnetOccupationOverview(code, apiKey, fetchImpl = fetch) {
  if (!ONET_CODE.test(String(code || ""))) throw new TypeError("invalid_occupation_code");
  const overview = await onetFetch(`/mnm/careers/${encodeURIComponent(code)}/`, apiKey, fetchImpl);
  return {
    code: String(overview?.code || code),
    title: String(overview?.title || "Occupation"),
    description: String(overview?.what_they_do || ""),
    tasks: (Array.isArray(overview?.on_the_job) ? overview.on_the_job : []).slice(0, 3).map(String),
    brightOutlook: Boolean(overview?.tags?.bright_outlook),
    sourceUrl: `https://www.onetonline.org/link/summary/${encodeURIComponent(code)}`
  };
}

function normalizeSkills(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.slice(0, 5).map((group) => ({
    name: String(group?.name || "Skill"),
    examples: Array.isArray(group?.element)
      ? group.element.slice(0, 3).map((item) => String(item?.name || "")).filter(Boolean)
      : []
  }));
}

function normalizeTechnology(groups) {
  if (!Array.isArray(groups)) return [];
  const names = [];
  for (const group of groups) {
    for (const item of Array.isArray(group?.example) ? group.example : []) {
      if (item?.title && !names.includes(item.title)) names.push(String(item.title));
      if (names.length === 8) return names;
    }
  }
  return names;
}

async function optionalOnet(path, apiKey, fetchImpl) {
  try {
    return await onetFetch(path, apiKey, fetchImpl);
  } catch (error) {
    if ([404, 422].includes(error.status)) return null;
    throw error;
  }
}

export async function handleOnetRoute(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/onet/")) return null;
  if (request.method !== "GET") {
    return json({ ok: false, reason: "method_not_allowed" }, { status: 405 });
  }
  if (!env.ONET_API_KEY) {
    return json({ ok: false, reason: "onet_not_configured" }, { status: 503 });
  }

  if (url.pathname === "/api/onet/search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length < 2 || query.length > 100) {
      return json({ ok: false, reason: "invalid_search" }, { status: 400 });
    }
    try {
      const occupations = await searchOnetOccupations(query, env.ONET_API_KEY, fetchImpl, 5);
      return json({
        ok: true,
        query,
        total: occupations.length,
        occupations: occupations.map(({ code, title, brightOutlook }) => ({ code, title, brightOutlook }))
      });
    } catch (error) {
      console.error("O*NET search failed", { status: error.status });
      return json({ ok: false, reason: "onet_unavailable" }, { status: 502 });
    }
  }

  const match = url.pathname.match(/^\/api\/onet\/occupations\/([^/]+)$/);
  if (!match) return json({ ok: false, reason: "not_found" }, { status: 404 });
  const code = decodeURIComponent(match[1]);
  if (!ONET_CODE.test(code)) {
    return json({ ok: false, reason: "invalid_occupation_code" }, { status: 400 });
  }

  try {
    const encodedCode = encodeURIComponent(code);
    const [overview, skills, education, technology, explore] = await Promise.all([
      onetFetch(`/mnm/careers/${encodedCode}/`, env.ONET_API_KEY, fetchImpl),
      optionalOnet(`/mnm/careers/${encodedCode}/skills`, env.ONET_API_KEY, fetchImpl),
      optionalOnet(`/mnm/careers/${encodedCode}/education`, env.ONET_API_KEY, fetchImpl),
      optionalOnet(`/mnm/careers/${encodedCode}/technology`, env.ONET_API_KEY, fetchImpl),
      optionalOnet(`/mnm/careers/${encodedCode}/explore_more`, env.ONET_API_KEY, fetchImpl)
    ]);
    return json({
      ok: true,
      occupation: {
        code: String(overview?.code || code),
        title: String(overview?.title || "Occupation"),
        description: String(overview?.what_they_do || ""),
        tasks: (Array.isArray(overview?.on_the_job) ? overview.on_the_job : []).slice(0, 5),
        alternateTitles: (Array.isArray(overview?.also_called) ? overview.also_called : [])
          .filter((item) => item?.summary && item?.title)
          .slice(0, 6)
          .map((item) => String(item.title)),
        brightOutlook: Boolean(overview?.tags?.bright_outlook),
        skills: normalizeSkills(skills),
        preparation: education?.job_zone ? {
          title: String(education.job_zone.title || ""),
          education: String(education.job_zone.education || ""),
          experience: String(education.job_zone.experience || ""),
          training: String(education.job_zone.training || "")
        } : null,
        education: Array.isArray(education?.education_usually_needed)
          ? education.education_usually_needed.slice(0, 5).map(String)
          : [],
        technology: normalizeTechnology(technology),
        related: (Array.isArray(explore?.careers) ? explore.careers : []).slice(0, 6).map((item) => ({
          code: String(item?.code || ""),
          title: String(item?.title || "")
        })).filter((item) => ONET_CODE.test(item.code) && item.title),
        sourceUrl: `https://www.onetonline.org/link/summary/${encodeURIComponent(code)}`
      }
    });
  } catch (error) {
    console.error("O*NET occupation request failed", { status: error.status, code });
    return json(
      { ok: false, reason: error.status === 422 ? "occupation_not_found" : "onet_unavailable" },
      { status: error.status === 422 ? 404 : 502 }
    );
  }
}
