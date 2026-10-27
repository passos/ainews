import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isEnabled } from "../../src/lib/flags";
import { loadSiteShell } from "../../src/server/publication/shell";
import { resetPublication, seedSections } from "../publication/helpers";

beforeEach(async () => {
  await resetPublication();
  await seedSections();
});

describe("loadSiteShell and the reader watch switch", () => {
  it("is off under env.test", async () => {
    expect(isEnabled(env, "READER_WATCH_ENABLED")).toBe(false);
    const shell = await loadSiteShell();
    expect(shell.readerWatchEnabled).toBe(false);
  });

  it("a reader watch alone does not make the header link appear", async () => {
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, status,
         owner_kind, token_hash, creator_hash, created_at, updated_at)
       VALUES ('r-0123456789abcdef', 'zq-reader-private-3 question here',
         'zq-reader-private-3 criteria here', '["agent"]', 'active',
         'reader', ?1, ?2, 1000, 1000)`,
    )
      .bind("a".repeat(64), "b".repeat(64))
      .run();
    const shell = await loadSiteShell();
    expect(shell.hasWatches).toBe(false);
    expect(JSON.stringify(shell)).not.toContain("zq-reader-private-3");
  });
});
