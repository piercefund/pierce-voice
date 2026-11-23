const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/gmail.send"
];

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function redirectUri(env) {
  return env.GOOGLE_OAUTH_REDIRECT_URI ||
    "https://pierce-voice-cloudflare-staging.piercefund.workers.dev/calendar/oauth/callback";
}

function readCookie(request, name) {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function setupPage(title, message, refreshToken = "") {
  const tokenSection = refreshToken
    ? `<label for="refreshToken">Google refresh token</label>
       <textarea id="refreshToken" readonly rows="5">${escapeHtml(refreshToken)}</textarea>
       <p>Copy this value now, then store it with Wrangler. Do not save it in source code or share it.</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
    <style>body{font:16px system-ui;max-width:720px;margin:64px auto;padding:0 24px;color:#172033}main{border:1px solid #d6dae1;padding:32px;border-radius:8px}h1{font-size:28px}textarea{box-sizing:border-box;width:100%;font:14px ui-monospace,monospace;padding:12px;margin-top:8px}</style>
    </head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${tokenSection}</main></body></html>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    ...headers
  } });
}

async function connect(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return html(setupPage("Google setup needed", "The staging Google OAuth client secrets are not configured."), 503);
  }
  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent select_account",
    login_hint: env.GOOGLE_CALENDAR_ACCOUNT_EMAIL || "voice@pierce.fund",
    state
  }).toString();
  return new Response(null, { status: 302, headers: {
    location: authorization.toString(),
    "cache-control": "no-store",
    "set-cookie": `pierce_oauth_state=${encodeURIComponent(state)}; Max-Age=600; Path=/calendar/oauth/callback; Secure; HttpOnly; SameSite=Lax`
  } });
}

async function callback(request, env, url) {
  const expectedState = readCookie(request, "pierce_oauth_state");
  const state = url.searchParams.get("state") || "";
  const clearCookie = "pierce_oauth_state=; Max-Age=0; Path=/calendar/oauth/callback; Secure; HttpOnly; SameSite=Lax";
  if (!expectedState || state !== expectedState) {
    return html(setupPage("Authorization rejected", "The OAuth state was missing or expired. Start the connection again."), 400, { "set-cookie": clearCookie });
  }
  const code = url.searchParams.get("code") || "";
  if (!code) {
    return html(setupPage("Authorization was not completed", url.searchParams.get("error") || "Google did not return an authorization code."), 400, { "set-cookie": clearCookie });
  }
  const response = await fetch(env.GOOGLE_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(env),
      grant_type: "authorization_code"
    })
  });
  const result = await response.json();
  if (!response.ok || !result.refresh_token) {
    return html(setupPage("Google connection incomplete", "Google did not return a refresh token. Start again and approve all requested access."), 502, { "set-cookie": clearCookie });
  }
  return html(setupPage("Google authorization complete", "The staging OAuth grant succeeded.", result.refresh_token), 200, { "set-cookie": clearCookie });
}

export async function handleGoogleRoute(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET") return null;
  if (url.pathname === "/calendar/connect") return connect(request, env);
  if (url.pathname === "/calendar/oauth/callback") return callback(request, env, url);
  if (url.pathname === "/calendar/status") {
    return json({ ok: true, configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALENDAR_REFRESH_TOKEN),
      client_configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      refresh_token_configured: Boolean(env.GOOGLE_CALENDAR_REFRESH_TOKEN),
      account_email: env.GOOGLE_CALENDAR_ACCOUNT_EMAIL || "voice@pierce.fund" });
  }
  return null;
}
