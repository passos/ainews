// The edge keeps the private feed headers on /rss/p/*, on every status
// (#132 slice 4, architecture §6 "读者 watch": 私有 RSS 的响应头).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleFetch, type EdgeEnv } from "../../src/server/edge";
import { readerFeedResponse } from "../../src/server/reader-watch/feed";
import { newReaderToken, tokenHash } from "../../src/server/reader-watch/token";
import { db, resetPublication, seedSections } from "../publication/helpers";

const SITE = "https://news.ioenv.com";
const ENV: EdgeEnv = {
  SITE_URL: SITE,
  ADMIN_EMAIL: "admin@example.com",
  ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
};
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function expectPrivateHeaders(res: Response): void {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
  // The site security headers are still there.
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
}

/** Routes /rss/p/{token}.xml to the real feed, like the server route. */
function feedHandler(request: Request): Promise<Response> {
  const m = /^\/rss\/p\/([^/]+)\.xml$/.exec(new URL(request.url).pathname);
  return readerFeedResponse(db(), SITE, m ? m[1]! : "", NOW);
}

const get = (
  path: string,
  handler: (r: Request) => Response | Promise<Response>,
) => handleFetch(new Request(`${SITE}${path}`), ENV, { handler });

beforeEach(async () => {
  await resetPublication();
  await seedSections();
});

describe("edge headers on the private feed (#132)", () => {
  it("200 for a reader token", async () => {
    const token = newReaderToken();
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, status, owner_kind, token_hash, created_at, updated_at)
       VALUES ('r-00000000000000ee', 'Question text here', 'Criteria text here', '["agent"]', 'active', 'reader', ?1, 100, 100)`,
    )
      .bind(await tokenHash(token))
      .run();
    const res = await get(`/rss/p/${token}.xml`, feedHandler);
    expect(res.status).toBe(200);
    expectPrivateHeaders(res);
  });

  it("404 for an unknown well-formed token", async () => {
    const res = await get(`/rss/p/${newReaderToken()}.xml`, feedHandler);
    expect(res.status).toBe(404);
    expectPrivateHeaders(res);
  });

  it("500 when the handler throws", async () => {
    const res = await get(`/rss/p/${newReaderToken()}.xml`, () => {
      throw new Error("D1 failed");
    });
    expect(res.status).toBe(500);
    expectPrivateHeaders(res);
  });

  it("403 for a write from a foreign Origin", async () => {
    const res = await handleFetch(
      new Request(`${SITE}/rss/p/${newReaderToken()}.xml`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      ENV,
      { handler: () => new Response("ok") },
    );
    expect(res.status).toBe(403);
    expectPrivateHeaders(res);
  });

  it("sets the headers even when the handler sets none", async () => {
    const res = await get(
      `/RSS/p/${newReaderToken()}.xml`,
      () => new Response("ok", { status: 200 }),
    );
    expectPrivateHeaders(res);
  });

  it("leaves other feeds with the site Referrer-Policy", async () => {
    const res = await get(
      "/rss/w/tech.xml",
      () => new Response("ok", { status: 200 }),
    );
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
