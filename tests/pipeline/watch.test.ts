import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateEventWatches } from "../../src/pipeline/watch/evaluate";
import { enqueueDueWatches } from "../../src/pipeline/watch/schedule";
import type { ModelClient } from "../../src/providers/models";

describe("pipeline: watch evaluation", () => {
  let sourceId: number;

  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM watch_hits`).run();
    await env.DB.prepare(`DELETE FROM watches`).run();

    await env.DB.prepare(
      `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
       VALUES (1, 'tech', 'Tech', 'review', '[]', '{}', 1, 1000),
              (2, 'edu', 'Edu', 'review', '[]', '{}', 1, 1000)
       ON CONFLICT DO NOTHING`,
    ).run();

    const src = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (1, 'Test Source', 'https://example.com/feed.xml', 'example.com', 'rss', 'active', 1000)
       ON CONFLICT DO NOTHING
       RETURNING id`,
    ).first<{ id: number }>();

    if (src) {
      sourceId = src.id;
    } else {
      const existing = await env.DB.prepare(
        `SELECT id FROM sources WHERE feed_url = 'https://example.com/feed.xml'`,
      ).first<{ id: number }>();
      sourceId = existing!.id;
    }
  });

  it("skips model call when industry scope does not match", async () => {
    // 1. Setup event in industry 2
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (2, 'AI in Higher Education', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    // 2. Setup article approved
    const artRes = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (2, ?1, 'https://example.com/art1', 'https://example.com/art1', 'Classroom AI Trial', 'Summary 1', 'sha123', 'grouped', 1000, 1000)`,
    )
      .bind(sourceId)
      .run();
    const articleId = Number(artRes.meta.last_row_id);

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha123', 'approved', 'admin', 1000)`,
    )
      .bind(articleId)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, articleId)
      .run();

    // 3. Setup watch scoped to industry 1
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('tech-watch', 'Question?', 'Criteria', '["AI"]', 1, 'active', 1000, 1000)`,
    ).run();

    const mockJudge = vi.fn();
    const mockModels = {
      judge: mockJudge,
      generateText: vi.fn(),
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 1000, {
      models: mockModels,
    });

    expect(res.evaluatedCount).toBe(0);
    expect(res.hitCount).toBe(0);
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("skips model call when keywords do not match", async () => {
    // Setup event
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Semiconductor Supply Chain Report', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    // Setup article approved
    const artRes = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art2', 'https://example.com/art2', 'TSMC Expands Fab in Arizona', 'Chip production updates', 'sha456', 'grouped', 1000, 1000)`,
    )
      .bind(sourceId)
      .run();
    const articleId = Number(artRes.meta.last_row_id);

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha456', 'approved', 'admin', 1000)`,
    )
      .bind(articleId)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, articleId)
      .run();

    // Setup watch with unrelated keywords
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('biotech-watch', 'Cancer drug discoveries', 'Criteria', '["oncology", "clinical trial"]', 1, 'active', 1000, 1000)`,
    ).run();

    const mockJudge = vi.fn();
    const mockModels = {
      judge: mockJudge,
      generateText: vi.fn(),
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 1000, {
      models: mockModels,
    });

    expect(res.evaluatedCount).toBe(0);
    expect(res.hitCount).toBe(0);
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("skips model call when watch was already hit for this revision (idempotency)", async () => {
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'OpenAI Announces GPT-5 Evaluation', 2, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const artRes = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art3', 'https://example.com/art3', 'Third-Party Benchmarks for GPT-5 Released', 'Independent benchmark scores', 'sha789', 'grouped', 1000, 1000)`,
    )
      .bind(sourceId)
      .run();
    const articleId = Number(artRes.meta.last_row_id);

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha789', 'approved', 'admin', 1000)`,
    )
      .bind(articleId)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, articleId)
      .run();

    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('gpt-5-idem', 'GPT-5 Benchmarks', 'Criteria', '["benchmark", "gpt-5"]', 1, 'active', 1000, 1000)`,
    ).run();
    const watchId = Number(watchRes.meta.last_row_id);

    // Pre-insert hit for revision 2
    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 2, 1000, 'Prior summary', '{}')`,
    )
      .bind(watchId, eventId)
      .run();

    const mockJudge = vi.fn();
    const mockModels = {
      judge: mockJudge,
      generateText: vi.fn(),
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 1000, {
      models: mockModels,
    });

    expect(res.evaluatedCount).toBe(0);
    expect(res.hitCount).toBe(0);
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("does not record hit when Jev judge determines no material progress (noul < 0.5)", async () => {
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Rumors on Next-Gen Chip Pricing', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const artRes = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art4', 'https://example.com/art4', 'Blogger Speculates on GPU Pricing', 'No official announcement yet', 'sha101', 'grouped', 1000, 1000)`,
    )
      .bind(sourceId)
      .run();
    const articleId = Number(artRes.meta.last_row_id);

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha101', 'approved', 'admin', 1000)`,
    )
      .bind(articleId)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, articleId)
      .run();

    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('gpu-pricing', 'Official GPU Pricing', 'Must be official manufacturer announcement', '["GPU", "pricing"]', 1, 'active', 1000, 1000)`,
    ).run();
    const watchId = Number(watchRes.meta.last_row_id);

    const mockJudge = vi.fn().mockResolvedValue({
      progress: { noul: 0.1 },
    });
    const mockGenerateText = vi.fn();
    const mockModels = {
      judge: mockJudge,
      generateText: mockGenerateText,
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 1000, {
      models: mockModels,
    });

    expect(res.evaluatedCount).toBe(1);
    expect(res.hitCount).toBe(0);
    expect(mockJudge).toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();

    const hit = await env.DB.prepare(
      `SELECT 1 FROM watch_hits WHERE watch_id = ?1 AND event_id = ?2`,
    )
      .bind(watchId, eventId)
      .first();
    expect(hit).toBeNull();
  });

  it("records hit and writes summary when Jev judge confirms material development (noul >= 0.5)", async () => {
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'NVIDIA Launches Blackwell GPU Official Pricing', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const artRes = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art5', 'https://example.com/art5', 'NVIDIA Confirms Blackwell Enterprise Pricing', 'Official press release and price schedule', 'sha202', 'grouped', 1000, 1000)`,
    )
      .bind(sourceId)
      .run();
    const articleId = Number(artRes.meta.last_row_id);

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha202', 'approved', 'admin', 1000)`,
    )
      .bind(articleId)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, articleId)
      .run();

    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('official-blackwell', 'Official Blackwell Pricing', 'Must be official manufacturer announcement', '["Blackwell", "pricing"]', 1, 'active', 1000, 1000)`,
    ).run();
    const watchId = Number(watchRes.meta.last_row_id);

    const mockJudge = vi.fn().mockResolvedValue({
      progress: { noul: 0.95 },
    });
    const mockGenerateText = vi.fn().mockResolvedValue({
      text: "NVIDIA published official pricing and release schedule for Blackwell GPUs.",
    });
    const mockModels = {
      judge: mockJudge,
      generateText: mockGenerateText,
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 2500, {
      models: mockModels,
    });

    expect(res.evaluatedCount).toBe(1);
    expect(res.hitCount).toBe(1);
    expect(mockJudge).toHaveBeenCalled();
    expect(mockGenerateText).toHaveBeenCalled();

    const hit = await env.DB.prepare(
      `SELECT * FROM watch_hits WHERE watch_id = ?1 AND event_id = ?2`,
    )
      .bind(watchId, eventId)
      .first<{
        watch_id: number;
        event_id: number;
        event_revision: number;
        hit_at: number;
        summary: string;
        rationale: string;
      }>();

    expect(hit).not.toBeNull();
    expect(hit?.event_revision).toBe(1);
    expect(hit?.hit_at).toBe(2500);
    expect(hit?.summary).toContain("official pricing");
    expect(hit?.rationale).toContain('"noul":0.95');
  });

  it("enqueueDueWatches enqueues events when active watches exist", async () => {
    // Insert active watch
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('enqueue-watch', 'Question?', 'Criteria', '[]', 1, 'active', 1000, 1000)`,
    ).run();

    // Insert event and approved article
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Active Watch Event', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const artRes = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-enqueue', 'https://example.com/art-enqueue', 'Title', 'Summary', 'shaEnqueue', 'grouped', 1000, 1000)`,
    )
      .bind(sourceId)
      .run();
    const articleId = Number(artRes.meta.last_row_id);

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaEnqueue', 'approved', 'admin', 1000)`,
    )
      .bind(articleId)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, articleId)
      .run();

    const queueMock = {
      sendBatch: vi.fn().mockResolvedValue(undefined),
    };

    const ids = await enqueueDueWatches(
      {
        DB: env.DB,
        Q_GENERATE: queueMock as unknown as Queue,
      },
      1000,
    );

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain(eventId);
    expect(queueMock.sendBatch).toHaveBeenCalled();
  });
});
