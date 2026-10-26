import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SITE_NAME } from "../../src/lib/site";
import {
  getWatchView,
  renderWatchFeed,
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

let tech: { industryId: number; sourceId: number };
let fin: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech, finance: fin } = await seedSections());
});

describe("tests/routes/watch.test.ts", () => {
  it("getWatchView returns null for non-existent slug", async () => {
    const res = await getWatchView(db(), "non-existent");
    expect(res).toBeNull();
  });

  it("getWatchView returns watch details and approved article hits only", async () => {
    // 1. Create watch
    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('deepseek-r1-evals', 'Independent Evaluations of DeepSeek-R1', 'Must test on verifiable reasoning benchmarks', '["deepseek", "eval"]', ?1, 'active', 1000, 1000)
       RETURNING id`,
    )
      .bind(tech.industryId)
      .first<{ id: number }>();
    const watchId = watchRes!.id;

    // 2. Create event
    const eventId = await seedEvent(
      tech.industryId,
      "DeepSeek-R1 Model Released with Open Weights",
      1,
    );

    // 3. Create approved article and unapproved article
    const artApproved = await seedArticle({
      ...tech,
      title: "Third Party Benchmarks of DeepSeek-R1 Reasoning",
      summary: "Evaluated across AIME and MATH benchmarks.",
      publishedAt: 1000,
    });
    const artUnapproved = await seedArticle({
      ...tech,
      title: "Rumors about DeepSeek Architecture",
      summary: "Unverified rumor",
      publishedAt: 1500,
    });

    await seedEventArticle(eventId, artApproved, 1000);
    await seedEventArticle(eventId, artUnapproved, 1500);

    await seedReview(artApproved, "approved");
    // artUnapproved has no approved review

    // 4. Record hit
    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 1, 2000, 'Independent benchmark shows competitive performance on reasoning tasks.', '{"noul":0.92}')`,
    )
      .bind(watchId, eventId)
      .run();

    // 5. Query public view
    const view = await getWatchView(db(), "deepseek-r1-evals");
    expect(view).not.toBeNull();
    expect(view!.watch.slug).toBe("deepseek-r1-evals");
    expect(view!.watch.question).toBe("Independent Evaluations of DeepSeek-R1");
    expect(view!.watch.keywords).toEqual(["deepseek", "eval"]);
    expect(view!.hits.length).toBe(1);

    const hit = view!.hits[0];
    expect(hit.eventId).toBe(eventId);
    expect(hit.summary).toContain("Independent benchmark shows competitive");
    expect(hit.articles.length).toBe(1);
    expect(hit.articles[0].title).toBe(
      "Third Party Benchmarks of DeepSeek-R1 Reasoning",
    );
  });

  it("renderWatchFeed and watchFeedResponse emit valid RSS 2.0", async () => {
    // 1. Create watch
    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('reasoning-models', 'New Reasoning LLM Releases', 'Must have published model weights or api', '["reasoning"]', ?1, 'active', 1000, 1000)
       RETURNING id`,
    )
      .bind(tech.industryId)
      .first<{ id: number }>();
    const watchId = watchRes!.id;

    // 2. Create event & approved article
    const eventId = await seedEvent(tech.industryId, "o3 Model Preview", 1);
    const art = await seedArticle({
      ...tech,
      title: "OpenAI Details o3 Capabilities",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, art, 1000);
    await seedReview(art, "approved");

    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 1, 3000, 'OpenAI previews o3 with new ARC-AGI benchmark results.', '{"noul":0.88}')`,
    )
      .bind(watchId, eventId)
      .run();

    // 404 test
    const notFoundRes = await watchFeedResponse(
      db(),
      "https://news.ioenv.com",
      "missing-watch",
    );
    expect(notFoundRes.status).toBe(404);

    // 200 test
    const view = await getWatchView(db(), "reasoning-models");
    const rawXml = renderWatchFeed(view!, "https://news.ioenv.com");
    expect(rawXml).toContain("OpenAI previews o3");

    const res = await watchFeedResponse(
      db(),
      "https://news.ioenv.com",
      "reasoning-models",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");

    const xml = await res.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rss version="2.0"><channel>');
    expect(xml).toContain(
      `<title>${SITE_NAME} — Watch: New Reasoning LLM Releases</title>`,
    );
    expect(xml).toContain(
      "<link>https://news.ioenv.com/w/reasoning-models</link>",
    );
    expect(xml).toContain("<item>");
    expect(xml).toContain(
      "OpenAI previews o3 with new ARC-AGI benchmark results.",
    );
  });

  it("filters out hits where all associated articles are unapproved", async () => {
    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('filter-unapproved-watch', 'Question?', 'Criteria', '["filter"]', ?1, 'active', 1000, 1000)
       RETURNING id`,
    )
      .bind(tech.industryId)
      .first<{ id: number }>();
    const watchId = watchRes!.id;

    const eventId = await seedEvent(tech.industryId, "Retracted Event", 1);
    const unapprovedArt = await seedArticle({
      ...tech,
      title: "Unapproved Article",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, unapprovedArt, 1000);
    // Note: unapprovedArt has no approved review

    // A hit row exists
    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 1, 1000, 'Summary of retracted info', '{}')`,
    )
      .bind(watchId, eventId)
      .run();

    const view = await getWatchView(db(), "filter-unapproved-watch");
    expect(view).not.toBeNull();
    // Hit is filtered out because it has 0 approved articles
    expect(view!.hits.length).toBe(0);
  });

  it("includes industry disclaimer in WatchDetailView and RSS feed when industry has disclaimer", async () => {
    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('rate-cuts', 'Fed Rate Decisions', 'Interest rate changes', '["rates"]', ?1, 'active', 1000, 1000)
       RETURNING id`,
    )
      .bind(fin.industryId)
      .first<{ id: number }>();
    const watchId = watchRes!.id;

    const eventId = await seedEvent(fin.industryId, "Fed Rate Decision", 1);
    const art = await seedArticle({
      industryId: fin.industryId,
      sourceId: fin.sourceId,
      title: "Fed Cuts Rates by 25bps",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, art, 1000);
    await seedReview(art, "approved");

    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 1, 2000, 'Fed lowers federal funds rate target.', '{}')`,
    )
      .bind(watchId, eventId)
      .run();

    const view = await getWatchView(db(), "rate-cuts");
    expect(view).not.toBeNull();
    expect(view!.watch.industryDisclaimer).toBeTruthy();

    const rss = renderWatchFeed(view!, "https://news.ioenv.com");
    expect(rss).toContain(view!.watch.industryDisclaimer!);
  });

  it("filters out hit when its specific supporting article was retracted, even if background articles remain", async () => {
    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('partial-retract-watch', 'Question?', 'Criteria', '["retract"]', ?1, 'active', 1000, 1000)
       RETURNING id`,
    )
      .bind(tech.industryId)
      .first<{ id: number }>();
    const watchId = watchRes!.id;

    const eventId = await seedEvent(
      tech.industryId,
      "Event with Retracted Breakthrough",
      2,
    );

    // Background article remains approved
    const backgroundArt = await seedArticle({
      ...tech,
      title: "Background Context Article",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, backgroundArt, 1000);
    await seedReview(backgroundArt, "approved");

    // Breakthrough article was retracted
    const breakthroughArt = await seedArticle({
      ...tech,
      title: "Breakthrough Claim Article",
      publishedAt: 2000,
    });
    await seedEventArticle(eventId, breakthroughArt, 2000);
    // breakthroughArt was rejected / not approved
    await seedReview(breakthroughArt, "rejected");

    // Hit was recorded based on [backgroundArt, breakthroughArt]
    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 2, 2000, 'Breakthrough claimed.', ?3)`,
    )
      .bind(
        watchId,
        eventId,
        JSON.stringify({
          noul: 0.9,
          articleIds: [backgroundArt, breakthroughArt],
        }),
      )
      .run();

    const view = await getWatchView(db(), "partial-retract-watch");
    expect(view).not.toBeNull();
    // Hit is filtered out because article 2 was retracted!
    expect(view!.hits.length).toBe(0);
  });

  it("surfaces Finance disclaimer for global watch (industry_id = null) when it hits a Finance event alongside a Tech event", async () => {
    // Global watch with industry_id = null
    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('global-finance-watch', 'Interest Rates', 'Rate cuts or hikes', '["rates"]', NULL, 'active', 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    const watchId = watchRes!.id;

    // 1. Tech event (newer hit, t=3000)
    const techEventId = await seedEvent(
      tech.industryId,
      "Tech Chip Subsidies",
      1,
    );
    const techArt = await seedArticle({
      industryId: tech.industryId,
      sourceId: tech.sourceId,
      title: "Tech Chip Subsidies Approved",
      publishedAt: 3000,
    });
    await seedEventArticle(techEventId, techArt, 3000);
    await seedReview(techArt, "approved");

    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 1, 3000, 'Tech subsidies rate.', '{}')`,
    )
      .bind(watchId, techEventId)
      .run();

    // 2. Finance event (older hit, t=2000)
    const finEventId = await seedEvent(
      fin.industryId,
      "Global Fed Rate Event",
      1,
    );
    const finArt = await seedArticle({
      industryId: fin.industryId,
      sourceId: fin.sourceId,
      title: "Federal Reserve Adjusts Policy Rate",
      publishedAt: 1000,
    });
    await seedEventArticle(finEventId, finArt, 1000);
    await seedReview(finArt, "approved");

    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 1, 2000, 'Federal Reserve policy adjustment announced.', '{}')`,
    )
      .bind(watchId, finEventId)
      .run();

    const view = await getWatchView(db(), "global-finance-watch");
    expect(view).not.toBeNull();
    // Watch itself had industry_id = null, and newer hit is Tech, but Finance hit has disclaimer,
    // so Finance disclaimer is bubbled to watch level and present on Finance hit
    expect(view!.watch.industryDisclaimer).toContain("investment advice");
    const finHit = view!.hits.find((h) => h.eventId === finEventId);
    expect(finHit?.disclaimer).toContain("investment advice");

    const rss = renderWatchFeed(view!, "https://news.ioenv.com");
    expect(rss).toContain("investment advice");
  });
});
