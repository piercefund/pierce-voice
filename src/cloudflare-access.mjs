import { createRemoteJWKSet, jwtVerify } from "jose";

const jwksByIssuer = new Map();

function normalizedIssuer(value) {
  const issuer = String(value || "").trim().replace(/\/$/, "");
  if (!issuer) return "";
  return issuer.startsWith("https://") ? issuer : `https://${issuer}`;
}

function remoteJwks(issuer) {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

export async function accessIdentity(request, env, ctx) {
  if (ctx?.access) {
    const identity = await ctx.access.getIdentity();
    if (identity?.email) return { email: identity.email, name: identity.name || "" };
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  const issuer = normalizedIssuer(env.CF_ACCESS_TEAM_DOMAIN);
  const audience = String(env.CF_ACCESS_AUD || "").trim();
  if (!token || !issuer || !audience) return null;

  try {
    const { payload } = await jwtVerify(token, remoteJwks(issuer), { issuer, audience });
    return payload.email ? { email: String(payload.email), name: String(payload.name || "") } : null;
  } catch (error) {
    console.error(JSON.stringify({ message: "Cloudflare Access token validation failed", error: error.message }));
    return null;
  }
}
