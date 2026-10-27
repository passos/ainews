import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getHome } from "../../src/server/publication/articles";
import {
  getActiveWatchesView,
  getWatchView,
  hasActiveWatches,
  watchFeedResponse,
} from "../../src/server/publication/watches";
import {
  db,
  resetPublication,
  seedArticle,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

const MARKER = "zq-reader-private-1";
const READER_SLUG = "r-0123456789abcdef";
const SITE = "https://news.example";

let tech: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
});

async function insertWatch(
  slug: string,
  ownerKind: string | null,
  question: string,
): Promise<number> {
  const columns = ownerKind === null ? "" : ", owner_kind";
  const values = ownerKind === null ? "" : ", ?4";
  const stmt = env.DB.prepare(
    `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at${columns})
     VALUES (?1, ?2, 'A measured change, not an opinion piece.', '["agent"]', ?3, 'active', 100, 100${values})
     RETURNING id`,
  );
  const bound =
    ownerKind === null
      ? stmt.bind(slug, question, tech.industryId)
      : stmt.bind(slug, question, tech.industryId, ownerKind);
  return (await bound.first<{ id: number }>())!.id;
}

/** A published hit on an event with one approved article. */
async function seedPublishedHit(watchId: number): Promise<void> {
  const eventId = await seedEvent(tech.industryId, "Agent protocol update", 1);
  const articleId = await seedArticle({
    ...tech,
    title: "Agent handshake overhead drops",
    summary: "Measured on a public benchmark.",
  });
  await seedEventArticle(eventId, articleId, 200);
  await seedReview(articleId, "approved");
  await env.DB.prepare(
    `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale, status)
     VALUES (?1, ?2, 1, 300, ?3, ?4, 'published')`,
  )
    .bind(
      watchId,
      eventId,
      `What changed for ${MARKER}`,
      JSON.stringify({ articleIds: [articleId] }),
    )
    .run();
}

describe("reader watches stay off public reads (#132)", () => {
  it("hides a reader watch and its published hit from every public read", async () => {
    const id = await insertWatch(
      READER_SLUG,
      "reader",
      `When does ${MARKER} ship?`,
    );
    await seedPublishedHit(id);

    const view = await getWatchView(db(), READER_SLUG);
    expect(view).toBeNull();

    const list = await getActiveWatchesView(db());
    expect(list.map((w) => w.id)).not.toContain(id);

    expect(await hasActiveWatches(db())).toBe(false);

    const home = await getHome(db());
    expect(home.watches.map((w) => w.slug)).not.toContain(READER_SLUG);

    const feed = await watchFeedResponse(db(), SITE, READER_SLUG);
    expect(feed.status).toBe(404);
    const feedText = await feed.text();

    for (const out of [view, list, home, feedText]) {
      expect(JSON.stringify(out)).not.toContain(MARKER);
    }
  });

  it("still lists an admin watch next to a reader watch", async () => {
    const adminId = await insertWatch(
      "tech-agent-protocols",
      null,
      "When do agent protocols get cheaper to run?",
    );
    const readerId = await insertWatch(
      READER_SLUG,
      "reader",
      `When does ${MARKER} ship?`,
    );
    await seedPublishedHit(readerId);

    expect((await getWatchView(db(), "tech-agent-protocols"))?.watch.id).toBe(
      adminId,
    );
    expect((await getActiveWatchesView(db())).map((w) => w.id)).toEqual([
      adminId,
    ]);
    expect(await hasActiveWatches(db())).toBe(true);
    expect((await getHome(db())).watches.map((w) => w.slug)).toEqual([
      "tech-agent-protocols",
    ]);
    expect(
      (await watchFeedResponse(db(), SITE, "tech-agent-protocols")).status,
    ).toBe(200);
  });

  it("does not publish a watch whose owner_kind is not 'admin'", async () => {
    await insertWatch("odd-owner", "partner", `Unknown owner ${MARKER}`);
    expect(await getWatchView(db(), "odd-owner")).toBeNull();
    expect(await hasActiveWatches(db())).toBe(false);
  });
});

describe("reader watch data guards (#132)", () => {
  it("keeps READER_WATCH_ENABLED off in the test env", () => {
    expect(env.READER_WATCH_ENABLED).toBe("false");
  });

  it("rejects a second watch with the same token_hash", async () => {
    const insert = (slug: string) =>
      env.DB.prepare(
        `INSERT INTO watches (slug, question, criteria, keywords, status, created_at, updated_at, owner_kind, token_hash)
         VALUES (?1, 'Question text here', 'Criteria text here', '["agent"]', 'active', 100, 100, 'reader', 'same-hash')`,
      )
        .bind(slug)
        .run();
    await insert("r-aaaaaaaaaaaaaaaa");
    await expect(insert("r-bbbbbbbbbbbbbbbb")).rejects.toThrow(/UNIQUE/i);
  });

  it("allows many admin watches with a NULL token_hash", async () => {
    await insertWatch("admin-one", null, "Admin question one here");
    await insertWatch("admin-two", null, "Admin question two here");
    const row = await env.DB.prepare(
      `SELECT count(*) AS n FROM watches WHERE owner_kind = 'admin' AND token_hash IS NULL`,
    ).first<{ n: number }>();
    expect(row!.n).toBe(2);
  });
});
