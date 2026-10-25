import { describe, expect, it } from "vitest";
import { handleFetch, type EdgeEnv } from "../../src/server/edge";

const ENV: EdgeEnv = {
  SITE_URL: "https://news.ioenv.com",
  ADMIN_EMAIL: "admin@example.com",
  ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
};

describe("admin access guard", () => {
  it("returns 403 for /admin routes without access token", async () => {
    for (const path of [
      "/admin",
      "/admin/review",
      "/admin/ledger",
      "/admin/ask",
    ]) {
      const req = new Request(`https://news.ioenv.com${path}`);
      const res = await handleFetch(req, ENV, {
        handler: async () => new Response("ok"),
      });
      expect(res.status).toBe(403);
    }
  });

  it("returns 403 for writes with wrong Origin header", async () => {
    const req = new Request("https://news.ioenv.com/_serverFn/someAdminFn", {
      method: "POST",
      headers: {
        Origin: "https://malicious.example",
      },
    });
    const res = await handleFetch(req, ENV, {
      handler: async () => new Response("ok"),
    });
    expect(res.status).toBe(403);
  });
});
