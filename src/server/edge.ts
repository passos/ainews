// Edge checks for every request, in a fixed order:
// admin path auth -> Origin check on writes -> server function body cap ->
// TanStack -> response headers.
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

/**
 * Body size cap for every /_serverFn/* write, checked before TanStack parses
 * the body (architecture §3 "公开写入口" rule 1).
 */
export const SERVER_FN_MAX_BODY_BYTES = 65536;

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

// The private reader feed /rss/p/{token}.xml (architecture §6 "读者 watch"):
// set after the site headers, on every status, so a 500 or an overwritten
// Referrer-Policy cannot leak the token URL.
const PRIVATE_FEED_HEADERS: [string, string][] = [
  ["Cache-Control", "private, no-store"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Robots-Tag", "noindex, nofollow"],
];

// Copies the headers, so responses with immutable headers (redirects) work,
// and keeps the body stream as is.
function withHeaders(
  res: Response,
  noStore: boolean,
  privateFeed = false,
): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  if (noStore) headers.set("Cache-Control", "no-store");
  if (privateFeed) {
    for (const [name, value] of PRIVATE_FEED_HEADERS) headers.set(name, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function forbidden(privateFeed = false): Response {
  return withHeaders(
    new Response("Forbidden", { status: 403 }),
    true,
    privateFeed,
  );
}

function refuse(status: number, text: string): Response {
  return withHeaders(new Response(text, { status }), true);
}

// The request to pass on (the original, or one rebuilt from the bytes read),
// or a 400/413 refusal. Without Content-Length, counts the body bytes and
// stops reading at the cap.
async function capBody(request: Request): Promise<Request | Response> {
  const length = request.headers.get("Content-Length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) return refuse(400, "bad_content_length");
    return Number(length) > SERVER_FN_MAX_BODY_BYTES
      ? refuse(413, "payload_too_large")
      : request;
  }
  if (request.body === null) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SERVER_FN_MAX_BODY_BYTES) {
      await reader.cancel();
      return refuse(413, "payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body: bytes });
}

export async function handleFetch(
  request: Request,
  env: EdgeEnv,
  deps: EdgeDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const admin = isAdminPath(pathname);
  const normalized = normalizePath(pathname) ?? "";
  const privateFeed = normalized.startsWith("/rss/p/");

  if (admin && !(await requireAdmin(request, env, deps.getKey))) {
    return forbidden();
  }

  if (!SAFE_METHODS.has(request.method)) {
    const expected = siteOrigin(env.SITE_URL);
    const origin = request.headers.get("Origin");
    if (expected === null || origin !== expected) return forbidden(privateFeed);
  }

  const serverFn = normalized.startsWith("/_serverfn");
  let forwarded = request;
  if (serverFn && !SAFE_METHODS.has(request.method)) {
    const capped = await capBody(request);
    if (capped instanceof Response) return capped;
    forwarded = capped;
  }

  let res: Response;
  try {
    res = await deps.handler(forwarded);
  } catch (error) {
    console.error("handler failed", error);
    res = new Response("Internal Server Error", { status: 500 });
  }
  return withHeaders(res, admin || serverFn, privateFeed);
}
