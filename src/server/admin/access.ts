// Cloudflare Access JWT checks for the admin area. Pure functions, no
// TanStack runtime, so tests can call them directly.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessEnv {
  ADMIN_EMAIL: string;
  // Full origin, for example "https://<team>.cloudflareaccess.com".
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const MAX_DECODES = 5;

// Decodes until the value is stable (at most MAX_DECODES times), merges runs
// of "/" and "\", and lowercases. Returns null when decoding fails or the
// value is still changing after MAX_DECODES, so the caller can fail closed.
export function normalizePath(p: string): string | null {
  let current = p;
  for (let i = 0; i <= MAX_DECODES; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) {
      return current.replace(/[/\\]+/g, "/").toLowerCase();
    }
    current = next;
  }
  return null;
}

// True for every variant of /admin, and for any path that cannot be decoded.
// The URL parser already resolves literal dot segments, so a "." or ".."
// segment here came from an encoded slash: fail closed.
export function isAdminPath(p: string): boolean {
  const normalized = normalizePath(p);
  if (normalized === null) return true;
  if (/(^|\/)\.\.?(\/|$)/.test(normalized)) return true;
  return /^\/admin($|[^a-z0-9_-])/.test(normalized);
}

// The header wins. The cookie is read only when there is no header: requests
// to /_serverFn are outside the Access app path and carry only the cookie.
export function extractAccessToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== "CF_Authorization") continue;
    const value = part.slice(index + 1).trim();
    return value || null;
  }
  return null;
}

export async function verifyAccessToken(
  token: string,
  options: {
    teamDomain: string;
    aud: string;
    adminEmail: string;
    getKey: JWTVerifyGetKey;
  },
): Promise<{ email: string } | null> {
  const { teamDomain, aud, adminEmail, getKey } = options;
  if (!TEAM_DOMAIN.test(teamDomain) || !aud || !adminEmail) return null;
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: teamDomain,
      audience: aud,
      algorithms: ["RS256"],
      // jose checks `exp` only when it is present. Require it.
      requiredClaims: ["exp"],
    });
    const email = payload.email;
    if (typeof email !== "string") return null;
    if (email.toLowerCase() !== adminEmail.toLowerCase()) return null;
    return { email };
  } catch {
    return null;
  }
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

export function getJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

// Returns the admin identity, or null for any failure, including bad config.
// The config is checked before the JWKS is built: an empty or malformed team
// domain must give 403, not a URL error.
export async function requireAdmin(
  request: Request,
  env: AccessEnv,
  getKey?: JWTVerifyGetKey,
): Promise<{ email: string } | null> {
  if (!TEAM_DOMAIN.test(env.ACCESS_TEAM_DOMAIN) || !env.ACCESS_AUD) {
    return null;
  }
  const token = extractAccessToken(request);
  if (!token) return null;
  return verifyAccessToken(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
    adminEmail: env.ADMIN_EMAIL,
    getKey: getKey ?? getJwks(env.ACCESS_TEAM_DOMAIN),
  });
}

// Body of accessMiddleware (src/server/admin/fn.ts), kept here so tests can
// call it without the TanStack runtime. Throws a 403 Response on any failure.
export async function adminOr403(
  request: Request,
  env: AccessEnv,
  getKey?: JWTVerifyGetKey,
): Promise<{ email: string }> {
  const admin = await requireAdmin(request, env, getKey);
  if (!admin) throw new Response("Forbidden", { status: 403 });
  return admin;
}
