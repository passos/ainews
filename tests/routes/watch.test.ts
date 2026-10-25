import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
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
      "<title>Personal News — Watch: New Reasoning LLM Releases</title>",
    );
    expect(xml).toContain(
      "<link>https://news.ioenv.com/w/reasoning-models</link>",
    );
    expect(xml).toContain("<item>");
    expect(xml).toContain(
      "OpenAI previews o3 with new ARC-AGI benchmark results.",
    );
  });
});
