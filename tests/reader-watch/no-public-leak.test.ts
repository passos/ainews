// A reader watch, its private feed address and its token never reach a
// public page, a public feed or loader data (#132 slice 4, architecture §6
// "读者 watch": 私有 RSS 不出现在公开页面、公开 RSS 和页面的 loader 数据里).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getHome } from "../../src/server/publication/articles";
import { getEvent } from "../../src/server/publication/events";
import {
  digestFeedResponse,
  feedResponse,
} from "../../src/server/publication/feed";
import { loadSiteShell } from "../../src/server/publication/shell";
import {
  getActiveWatchesView,
  getWatchView,
  renderWatchFeed,
} from "../../src/server/publication/watches";
import { readerFeedResponse } from "../../src/server/reader-watch/feed";
import { newReaderToken, tokenHash } from "../../src/server/reader-watch/token";
import {
  db,
  resetPublication,
  seedArticle,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

const MARKER = "zq-reader-private-2";
const SITE = "https://news.example";
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

let tech: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
});

async function insertWatch(
  slug: string,
  ownerKind: "admin" | "reader",
  question: string,
  hash: string | null,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, owner_kind,
       token_hash, created_at, updated_at)
     VALUES (?1, ?2, 'A measured change, not an opinion piece.', '["agent"]', ?3, 'active', ?4, ?5, 100, 100)
     RETURNING id`,
  )
    .bind(slug, question, tech.industryId, ownerKind, hash)
    .first<{ id: number }>();
  return row!.id;
}

async function insertHit(
  watchId: number,
  eventId: number,
  articleId: number,
  status: "delivered" | "published",
  summary: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale, status)
     VALUES (?1, ?2, 1, 300, ?3, ?4, ?5)`,
  )
    .bind(
      watchId,
      eventId,
      summary,
      JSON.stringify({ articleIds: [articleId] }),
      status,
    )
    .run();
}

describe("the private feed stays off public outputs (#132)", () => {
  it("no public page, feed or loader data shows the reader watch, its feed path or token", async () => {
    const token = newReaderToken();
    const readerId = await insertWatch(
      "r-00000000000000aa",
      "reader",
      `When does ${MARKER} ship?`,
      await tokenHash(token),
    );
    const adminId = await insertWatch(
      "tech-agent-protocols",
      "admin",
      "When do agent protocols get cheaper to run?",
      null,
    );

    const eventId = await seedEvent(
      tech.industryId,
      "Agent protocol update",
      1,
    );
    const articleId = await seedArticle({
      ...tech,
      title: "Agent handshake overhead drops",
      summary: "Measured on a public benchmark.",
    });
    await seedEventArticle(eventId, articleId, 200);
    await seedReview(articleId, "approved");
    await insertHit(readerId, eventId, articleId, "delivered", "");
    await insertHit(adminId, eventId, articleId, "published", "Cheaper now.");

    // The private feed itself works, so the checks below are not vacuous.
    const priv = await readerFeedResponse(db(), SITE, token, NOW);
    expect(priv.status).toBe(200);
    expect(await priv.text()).toContain(MARKER);

    const adminSlugs = await env.DB.prepare(
      "SELECT slug FROM watches WHERE owner_kind = 'admin'",
    ).all<{ slug: string }>();
    expect(adminSlugs.results.length).toBeGreaterThan(0);
    const adminFeeds: string[] = [];
    for (const { slug } of adminSlugs.results) {
      const view = await getWatchView(db(), slug);
      expect(view?.hits.length).toBeGreaterThan(0);
      adminFeeds.push(renderWatchFeed(view!, SITE));
    }

    const section = await feedResponse(db(), SITE, "technology");
    expect(section.status).toBe(200);
    const digest = await digestFeedResponse(db(), SITE, "technology");
    expect(digest.status).toBe(200);

    const outputs: Record<string, unknown> = {
      getHome: await getHome(db()),
      getActiveWatchesView: await getActiveWatchesView(db()),
      loadSiteShell: await loadSiteShell(),
      getEvent: await getEvent(db(), eventId),
      sectionRss: await section.text(),
      digestRss: await digest.text(),
      adminWatchFeeds: adminFeeds,
    };
    expect(JSON.stringify(outputs.getEvent)).toContain(
      "Agent handshake overhead drops",
    );
    for (const [name, out] of Object.entries(outputs)) {
      const text = typeof out === "string" ? out : JSON.stringify(out);
      expect(text, name).not.toContain(MARKER);
      expect(text, name).not.toContain("/rss/p/");
      expect(text, name).not.toContain(token);
    }
  });

  it("has no sitemap route (a future sitemap must exclude private feeds)", () => {
    const routes = Object.keys(import.meta.glob("../../src/routes/**/*"));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((p) => /sitemap/i.test(p))).toEqual([]);
  });
});
