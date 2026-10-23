import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { handleFetch, type EdgeEnv } from "../src/server/edge";

const ENV: EdgeEnv = {
  SITE_URL: "https://news.ioenv.com",
  ADMIN_EMAIL: "admin@example.com",
  ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
};
const SITE = "https://news.ioenv.com";
const KID = "k1";

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
  email?: string;
  exp?: number | null;
}

async function token(o: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ email: o.email ?? ENV.ADMIN_EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(o.iss ?? ENV.ACCESS_TEAM_DOMAIN)
    .setAudience(o.aud ?? ENV.ACCESS_AUD)
    .setIssuedAt();
  const exp = o.exp === undefined ? Math.floor(Date.now() / 1000) + 600 : o.exp;
  if (exp !== null) jwt.setExpirationTime(exp);
  return jwt.sign(o.key ?? signingKey);
}

function run(request: Request, env: EdgeEnv = ENV) {
  let calls = 0;
  const handler = () => {
    calls++;
    return new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  };
  return handleFetch(request, env, { handler, getKey }).then((res) => ({
    res,
    calls: () => calls,
  }));
}

const adminRequest = (headers: Record<string, string> = {}) =>
  new Request(`${SITE}/admin`, { headers });

describe("admin auth: 403 and no handler call", () => {
  const cases: [string, () => Promise<Request>, EdgeEnv?][] = [
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
      "invalid header wins over a valid cookie",
      async () =>
        adminRequest({
          "Cf-Access-Jwt-Assertion": await token({ key: otherKey }),
          Cookie: `CF_Authorization=${await token()}`,
        }),
    ],
  ];

  for (const [name, makeRequest, env] of cases) {
    it(name, async () => {
      const { res, calls } = await run(await makeRequest(), env);
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
  it("adds CSP and the other security headers to GET /", async () => {
    const { res } = await run(new Request(`${SITE}/`));
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
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
    expect(res.headers.get("Content-Security-Policy")).not.toBeNull();
  });
});
