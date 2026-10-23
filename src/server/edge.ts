// Edge checks for every request, in a fixed order:
// admin path auth -> Origin check on writes -> TanStack -> response headers.
// No TanStack runtime here, so tests call handleFetch directly.
import type { JWTVerifyGetKey } from "jose";
import { isAdminPath, normalizePath, requireAdmin } from "./admin/access";
import type { AccessEnv } from "./admin/access";

// Plain strings: the generated Env types vars as literals.
export interface EdgeEnv extends AccessEnv {
  SITE_URL: string;
}

export interface EdgeDeps {
  handler: (request: Request) => Response | Promise<Response>;
  getKey?: JWTVerifyGetKey;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const SECURITY_HEADERS: [string, string][] = [
  [
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https://cloudflareinsights.com; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  ],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-Frame-Options", "DENY"],
  ["Strict-Transport-Security", "max-age=31536000"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
];

function siteOrigin(siteUrl: string): string | null {
  try {
    return new URL(siteUrl).origin;
  } catch {
    return null;
  }
}

// Copies the headers, so responses with immutable headers (redirects) work,
// and keeps the body stream as is.
function withHeaders(res: Response, noStore: boolean): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  if (noStore) headers.set("Cache-Control", "no-store");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function forbidden(): Response {
  return withHeaders(new Response("Forbidden", { status: 403 }), true);
}

export async function handleFetch(
  request: Request,
  env: EdgeEnv,
  deps: EdgeDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const admin = isAdminPath(pathname);

  if (admin && !(await requireAdmin(request, env, deps.getKey))) {
    return forbidden();
  }

  if (!SAFE_METHODS.has(request.method)) {
    const expected = siteOrigin(env.SITE_URL);
    const origin = request.headers.get("Origin");
    if (expected === null || origin !== expected) return forbidden();
  }

  const res = await deps.handler(request);
  const serverFn = (normalizePath(pathname) ?? "").startsWith("/_serverfn");
  return withHeaders(res, admin || serverFn);
}
