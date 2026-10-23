import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { adminOr403, requireAdmin } from "../src/server/admin/access";
import { handleFetch, type EdgeEnv } from "../src/server/edge";

const ENV: EdgeEnv = {
  SITE_URL: "https://news.ioenv.com",
  ADMIN_EMAIL: "admin@example.com",
  ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
};
const SITE = "https://news.ioenv.com";
const KID = "k1";
const HMAC_SECRET = new TextEncoder().encode(
  "a-shared-secret-of-32-bytes-long",
);

// Exact values, written out here so a changed or dropped header fails.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https://cloudflareinsights.com; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function expectSecurityHeaders(res: Response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
}

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = other.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  getKey = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", kid: KID }] });
});

interface TokenOptions {
  key?: CryptoKey;
  iss?: string;
  aud?: string;
  email?: string | null;
  exp?: number | null;
}

async function token(o: TokenOptions = {}): Promise<string> {
  const email = o.email === undefined ? ENV.ADMIN_EMAIL : o.email;
  const jwt = new SignJWT(email === null ? {} : { email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(o.iss ?? ENV.ACCESS_TEAM_DOMAIN)
    .setAudience(o.aud ?? ENV.ACCESS_AUD)
    .setIssuedAt();
  const exp = o.exp === undefined ? Math.floor(Date.now() / 1000) + 600 : o.exp;
  if (exp !== null) jwt.setExpirationTime(exp);
  return jwt.sign(o.key ?? signingKey);
}

// HS256 with a key the verifier would accept if the algorithm were not pinned.
async function hs256Token(): Promise<string> {
  return new SignJWT({ email: ENV.ADMIN_EMAIL })
    .setProtectedHeader({ alg: "HS256", kid: KID })
    .setIssuer(ENV.ACCESS_TEAM_DOMAIN)
    .setAudience(ENV.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(HMAC_SECRET);
}

function run(
  request: Request,
  env: EdgeEnv = ENV,
  key: JWTVerifyGetKey = getKey,
) {
  let calls = 0;
  const handler = () => {
    calls++;
    return new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  };
  return handleFetch(request, env, { handler, getKey: key }).then((res) => ({
    res,
    calls: () => calls,
  }));
}

const adminRequest = (headers: Record<string, string> = {}) =>
  new Request(`${SITE}/admin`, { headers });

describe("admin auth: 403 and no handler call", () => {
  const cases: [
    string,
    () => Promise<Request>,
    EdgeEnv?,
    (() => JWTVerifyGetKey)?,
  ][] = [
    ["no token", async () => adminRequest()],
    [
      "signed with another key",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({ key: otherKey }),
        }),
    ],
    [
      "wrong aud",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({ aud: "other-aud" }),
        }),
    ],
    [
      "wrong iss",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({
            iss: "https://evil.cloudflareaccess.com",
          }),
        }),
    ],
    [
      "expired",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({
            exp: Math.floor(Date.now() / 1000) - 60,
          }),
        }),
    ],
    [
      "no exp claim",
      async () =>
        adminRequest({ "Cf-Access-Jwt-Assertion": await token({ exp: null }) }),
    ],
    [
      "wrong email",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({
            email: "someone@example.com",
          }),
        }),
    ],
    [
      "empty ACCESS_AUD (token also has aud '')",
      async () =>
        adminRequest({ "Cf-Access-Jwt-Assertion": await token({ aud: "" }) }),
      { ...ENV, ACCESS_AUD: "" },
    ],
    [
      "malformed ACCESS_TEAM_DOMAIN (token iss matches it)",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({
            iss: "https://test.evil.com",
          }),
        }),
      { ...ENV, ACCESS_TEAM_DOMAIN: "https://test.evil.com" },
    ],
    [
      "empty ACCESS_TEAM_DOMAIN",
      async () =>
        adminRequest({ "Cf-Access-Jwt-Assertion": await token({ iss: "" }) }),
      { ...ENV, ACCESS_TEAM_DOMAIN: "" },
    ],
    [
      "empty ADMIN_EMAIL (token email is also '')",
      async () =>
        adminRequest({ "Cf-Access-Jwt-Assertion": await token({ email: "" }) }),
      { ...ENV, ADMIN_EMAIL: "" },
    ],
    [
      "no email claim",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({ email: null }),
        }),
    ],
    [
      "HS256 token, even with a key that would verify it",
      async () =>
        adminRequest({ "Cf-Access-Jwt-Assertion": await hs256Token() }),
      undefined,
      () => async () => HMAC_SECRET,
    ],
    [
      "invalid header wins over a valid cookie",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({ key: otherKey }),
          Cookie: `CF_Authorization=${await token()}`,
        }),
    ],
  ];

  for (const [name, makeRequest, env, makeKey] of cases) {
    it(name, async () => {
      const { res, calls } = await run(
        await makeRequest(),
        env ?? ENV,
        makeKey ? makeKey() : getKey,
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(calls()).toBe(0);
    });
  }
});

describe("admin auth: valid token", () => {
  it("passes in the Cf-Access-Jwt-Assertion header", async () => {
    const { res, calls } = await run(
      adminRequest({ "Cf-Access-Jwt-Assertion": await token() }),
    );
    expect(res.status).toBe(200);
    expect(calls()).toBe(1);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes in the CF_Authorization cookie only", async () => {
    const { res, calls } = await run(
      adminRequest({ Cookie: `a=b; CF_Authorization=${await token()}; c=d` }),
    );
    expect(res.status).toBe(200);
    expect(calls()).toBe(1);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("matches the admin email case-insensitively", async () => {
    const { res } = await run(
      adminRequest({
        "Cf-Access-Jwt-Assertion": await token({ email: "Admin@Example.COM" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("admin path variants without a token", () => {
  const blocked = [
    "/admin",
    "/Admin",
    "//admin",
    "/%61dmin",
    "/%2561dmin",
    "/ADMIN/x",
    "/admin;x",
    "/admin/",
    "/%2Fadmin",
    "/%5Cadmin",
    // Encoded slash next to a dot segment: fail closed.
    "/x/..%2Fadmin",
    "/x/%2E%2E%2Fadmin",
    // Cannot be decoded: fail closed.
    "/%E0%A4%A",
  ];
  for (const path of blocked) {
    it(`blocks ${path}`, async () => {
      const { res, calls } = await run(new Request(`${SITE}${path}`));
      expect(new URL(`${SITE}${path}`).pathname).toBe(path);
      expect(res.status).toBe(403);
      expect(calls()).toBe(0);
    });
  }

  // Encoded public paths decode normally and are not treated as admin.
  for (const path of [
    "/administrator-guide",
    "/",
    "/s/caf%C3%A9",
    "/s/%2561",
  ]) {
    it(`allows ${path}`, async () => {
      const { res, calls } = await run(new Request(`${SITE}${path}`));
      expect(res.status).toBe(200);
      expect(calls()).toBe(1);
    });
  }
});

describe("Origin check on writes", () => {
  const post = (headers: Record<string, string> = {}) =>
    new Request(`${SITE}/`, { method: "POST", headers });

  it("rejects a foreign Origin", async () => {
    const { res, calls } = await run(post({ Origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(calls()).toBe(0);
  });

  it("rejects a missing Origin", async () => {
    const { res, calls } = await run(post());
    expect(res.status).toBe(403);
    expect(calls()).toBe(0);
  });

  it("calls the handler for the site Origin", async () => {
    const { res, calls } = await run(post({ Origin: SITE }));
    expect(res.status).toBe(200);
    expect(calls()).toBe(1);
  });

  it("rejects an admin write from a foreign Origin even with a valid token", async () => {
    const { res, calls } = await run(
      new Request(`${SITE}/admin`, {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Cf-Access-Jwt-Assertion": await token(),
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(calls()).toBe(0);
  });
});

describe("response headers", () => {
  it("adds all security headers, exact values, to GET /", async () => {
    const { res } = await run(new Request(`${SITE}/`));
    expectSecurityHeaders(res);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("adds no-store to GET /_serverFn/x", async () => {
    const { res } = await run(new Request(`${SITE}/_serverFn/x`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("handles a redirect with immutable headers", async () => {
    const res = await handleFetch(new Request(`${SITE}/old`), ENV, {
      handler: () => Response.redirect(`${SITE}/new`, 302),
      getKey,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${SITE}/new`);
    expectSecurityHeaders(res);
  });

  it("adds all security headers to a 403", async () => {
    const { res } = await run(adminRequest());
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  for (const path of ["/_serverFn/x", "/"]) {
    it(`returns 500 with headers when the handler throws on ${path}`, async () => {
      const res = await handleFetch(new Request(`${SITE}${path}`), ENV, {
        handler: () => {
          throw new Error("boom");
        },
        getKey,
      });
      expect(res.status).toBe(500);
      expectSecurityHeaders(res);
      expect(res.headers.get("Cache-Control")).toBe(
        path === "/" ? null : "no-store",
      );
    });
  }
});

describe("requireAdmin", () => {
  it("returns null for an empty team domain without a getKey (no URL error)", async () => {
    const request = adminRequest({ "Cf-Access-Jwt-Assertion": await token() });
    await expect(
      requireAdmin(request, { ...ENV, ACCESS_TEAM_DOMAIN: "" }),
    ).resolves.toBeNull();
  });
});

// The body of accessMiddleware, which guards admin server functions on
// /_serverFn (no /admin path, so the edge check does not run there).
describe("adminOr403", () => {
  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => "resolved",
      (error: unknown) => error,
    );
  }

  it("throws a 403 Response for the empty production config", async () => {
    const request = adminRequest({ "Cf-Access-Jwt-Assertion": await token() });
    const error = await rejection(
      adminOr403(request, {
        ...ENV,
        ACCESS_TEAM_DOMAIN: "",
        ACCESS_AUD: "",
      }),
    );
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(403);
  });

  it("throws a 403 Response for a wrong aud", async () => {
    const request = adminRequest({
      "Cf-Access-Jwt-Assertion": await token({ aud: "other-aud" }),
    });
    const error = await rejection(adminOr403(request, ENV, getKey));
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(403);
  });

  it("returns the admin for a valid header token", async () => {
    const request = adminRequest({ "Cf-Access-Jwt-Assertion": await token() });
    await expect(adminOr403(request, ENV, getKey)).resolves.toEqual({
      email: ENV.ADMIN_EMAIL,
    });
  });

  it("returns the admin for a valid cookie token", async () => {
    const request = new Request(`${SITE}/_serverFn/x`, {
      headers: { Cookie: `CF_Authorization=${await token()}` },
    });
    await expect(adminOr403(request, ENV, getKey)).resolves.toEqual({
      email: ENV.ADMIN_EMAIL,
    });
  });
});
