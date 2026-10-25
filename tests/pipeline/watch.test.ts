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
      finishReason: "STOP",
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
    // Insert active watch with keywords
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('enqueue-watch', 'Question?', 'Criteria', '["active"]', 1, 'active', 1000, 1000)`,
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

  it("enqueueDueWatches filters out events outside the time window", async () => {
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('window-watch', 'Question?', 'Criteria', '["window"]', 1, 'active', 1000, 1000)`,
    ).run();

    // Event updated 2 hours ago (outside 30m window)
    const oldEvent = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Old Event', 1, 1000, 1000 - 2 * 3600 * 1000) RETURNING id`,
    ).first<{ id: number }>();

    const artRes = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-old', 'https://example.com/art-old', 'Old Title', 'Summary', 'shaOld', 'grouped', 1000, 1000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaOld', 'approved', 'admin', 1000)`,
    )
      .bind(artRes!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(oldEvent!.id, artRes!.id)
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

    expect(ids).not.toContain(oldEvent!.id);
  });

  it("partitions articles into new and prior reporting for state contrast and avoids duplicate hits on commentary", async () => {
    // 1. Create event at revision 1
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Major Frontier Model Release', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    // Initial breakthrough article at t=1000
    const art1 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-breakthrough', 'https://example.com/art-breakthrough', 'Lab Releases Breakthrough Model', 'Breakthrough weights released', 'shaBreakthrough', 'grouped', 1000, 1000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaBreakthrough', 'approved', 'admin', 1000)`,
    )
      .bind(art1!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, art1!.id)
      .run();

    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('breakthrough-watch', 'Model Releases', 'Must be a new model release', '["Breakthrough", "Model"]', 1, 'active', 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    const watchId = watchRes!.id;

    // First evaluation: breakthrough hits!
    let mockJudge = vi.fn().mockResolvedValue({
      progress: { noul: 1.0 }, // testing noul = 1.0 is a hit
    });
    let mockGenerateText = vi.fn().mockResolvedValue({
      text: "Lab officially released the breakthrough model.",
      finishReason: "STOP",
    });
    let mockModels = {
      judge: mockJudge,
      generateText: mockGenerateText,
    } as unknown as ModelClient;

    const res1 = await evaluateEventWatches(env, eventId, 1000, {
      models: mockModels,
    });
    expect(res1.hitCount).toBe(1);

    // 2. Later, event revision is bumped to 2 with a secondary commentary article linked at t=2000
    await env.DB.prepare(
      `UPDATE events SET revision = 2, updated_at = 2000 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();

    const art2 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-commentary', 'https://example.com/art-commentary', 'Columnist Offers Opinions on Model', 'No new benchmarks or releases, just commentary', 'shaCommentary', 'grouped', 2000, 2000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaCommentary', 'approved', 'admin', 2000)`,
    )
      .bind(art2!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 2000)`,
    )
      .bind(eventId, art2!.id)
      .run();

    // Reset mocks for second evaluation
    mockJudge = vi.fn().mockResolvedValue({
      progress: { noul: 0.1 }, // Commentary does not count as material new development over prior release
    });
    mockGenerateText = vi.fn();
    mockModels = {
      judge: mockJudge,
      generateText: mockGenerateText,
    } as unknown as ModelClient;

    const res2 = await evaluateEventWatches(env, eventId, 2000, {
      models: mockModels,
    });

    expect(mockJudge).toHaveBeenCalled();
    const judgeCallArgs = mockJudge.mock.calls[0];
    const judgeState = judgeCallArgs[1] as { body: string };
    expect(judgeState.body).toContain("=== NEW REPORTING IN THIS UPDATE ===");
    expect(judgeState.body).toContain("Columnist Offers Opinions on Model");
    expect(judgeState.body).toContain(
      "=== PRIOR REPORTING (ALREADY KNOWN) ===",
    );
    expect(judgeState.body).toContain("Lab Releases Breakthrough Model");

    // Commentary does not trigger a hit
    expect(res2.hitCount).toBe(0);
    expect(mockGenerateText).not.toHaveBeenCalled();

    // Verify only 1 hit remains in watch_hits for revision 1, not revision 2
    const { results: allHits } = await env.DB.prepare(
      `SELECT * FROM watch_hits WHERE watch_id = ?1 AND event_id = ?2`,
    )
      .bind(watchId, eventId)
      .all();
    expect(allHits.length).toBe(1);
    expect(allHits[0].event_revision).toBe(1);
  });

  it("updates ledger key when watch criteria changes so cached results do not mask new criteria", async () => {
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'New Semiconductor Fab', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-fab', 'https://example.com/art-fab', 'Fab Groundbreaking', 'Groundbreaking ceremony', 'shaFab', 'grouped', 1000, 1000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaFab', 'approved', 'admin', 1000)`,
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, art!.id)
      .run();

    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('criteria-key-test', 'Fab Status', 'Initial criteria A', '["Fab"]', 1, 'active', 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    const watchId = watchRes!.id;

    const mockJudge = vi.fn().mockResolvedValue({ progress: { noul: 0.1 } });
    const mockModels = {
      judge: mockJudge,
      generateText: vi.fn(),
    } as unknown as ModelClient;

    await evaluateEventWatches(env, eventId, 1000, { models: mockModels });
    const firstKey = mockJudge.mock.calls[0][0];

    // Now update criteria
    await env.DB.prepare(
      `UPDATE watches SET criteria = 'Completely different criteria B' WHERE id = ?1`,
    )
      .bind(watchId)
      .run();

    mockJudge.mockClear();
    await evaluateEventWatches(env, eventId, 1000, { models: mockModels });
    const secondKey = mockJudge.mock.calls[0][0];

    expect(firstKey).not.toEqual(secondKey);
  });

  it("skips watch evaluation when keywords array is empty", async () => {
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Empty Keywords Event', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-empty-kw', 'https://example.com/art-empty-kw', 'Title', 'Summary', 'shaKw', 'grouped', 1000, 1000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaKw', 'approved', 'admin', 1000)`,
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('empty-kw-watch', 'Question?', 'Criteria', '[]', 1, 'active', 1000, 1000)`,
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
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("correctly matches symbol keywords (C#, .NET, $TSLA) and word-bounded ASCII (AI vs chain)", async () => {
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Microsoft Updates .NET 9 and C# 13 Runtime', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-dotnet', 'https://example.com/art-dotnet', 'New Features in .NET 9 and C# 13', 'Latest preview released', 'shaDotnet', 'grouped', 1000, 1000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaDotnet', 'approved', 'admin', 1000)`,
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, art!.id)
      .run();

    // 1. Symbol keyword "C#"
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('csharp-watch', 'C# Updates', 'Criteria', '["C#"]', 1, 'active', 1000, 1000)`,
    ).run();

    // 2. Symbol keyword ".NET"
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('dotnet-watch', '.NET Updates', 'Criteria', '[".NET"]', 1, 'active', 1000, 1000)`,
    ).run();

    // 3. Word-bounded "AI" should NOT match "chain"
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('ai-watch', 'AI Updates', 'Criteria', '["AI"]', 1, 'active', 1000, 1000)`,
    ).run();

    const mockJudge = vi.fn().mockResolvedValue({ progress: { noul: 0.1 } });
    const mockModels = {
      judge: mockJudge,
      generateText: vi.fn(),
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 1000, {
      models: mockModels,
    });

    // Both "C#" and ".NET" should match, while "AI" should not match
    expect(res.evaluatedCount).toBe(2);
    expect(mockJudge).toHaveBeenCalledTimes(2);
  });

  it("skips evaluation when revision bump is caused by a retraction (no new approved articles)", async () => {
    // Event at revision 2, updated at 20000, but only remaining article was approved at 10000
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Retraction Event', 2, 10000, 20000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-old-approved', 'https://example.com/art-old-approved', 'Old Article', 'Old summary', 'shaOldApp', 'grouped', 10000, 10000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaOldApp', 'approved', 'admin', 10000)`,
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 10000)`,
    )
      .bind(eventId, art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('retract-watch', 'Question?', 'Criteria', '["Article"]', 1, 'active', 10000, 10000)`,
    ).run();

    const mockJudge = vi.fn();
    const mockModels = {
      judge: mockJudge,
      generateText: vi.fn(),
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 20000, {
      models: mockModels,
    });
    // Zero evaluations because it was a retraction revision
    expect(res.evaluatedCount).toBe(0);
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("unconditionally discards partial text and uses fallback when summary finishReason !== 'STOP'", async () => {
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Truncated Summary Event', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-trunc', 'https://example.com/art-trunc', 'Benchmark Release Announcement', 'New benchmarks', 'shaTrunc', 'grouped', 1000, 1000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaTrunc', 'approved', 'admin', 1000)`,
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, art!.id)
      .run();

    const watchRes = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('trunc-watch', 'Benchmark Results', 'Empirical numbers', '["Benchmark"]', 1, 'active', 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    const watchId = watchRes!.id;

    const mockJudge = vi.fn().mockResolvedValue({ progress: { noul: 0.9 } });
    // Returns partial sentence cut off by MAX_TOKENS
    const mockGenerateText = vi.fn().mockResolvedValue({
      text: "The new benchmark achieved a score of 95.4% which is a substantial increase over",
      finishReason: "MAX_TOKENS",
    });
    const mockModels = {
      judge: mockJudge,
      generateText: mockGenerateText,
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 1000, {
      models: mockModels,
    });
    expect(res.hitCount).toBe(1);

    const hit = await env.DB.prepare(
      `SELECT * FROM watch_hits WHERE watch_id = ?1 AND event_id = ?2`,
    )
      .bind(watchId, eventId)
      .first<{ summary: string; rationale: string }>();

    // Partial sentence discarded, fallback title used
    expect(hit?.summary).toBe("Benchmark Release Announcement");
    expect(hit?.summary).not.toContain("95.4%");
    expect(hit?.rationale).toContain('"articleIds"');
  });

  it("evaluates article that was approved before being grouped (ea.created_at > r.created_at) without misidentifying as retraction", async () => {
    // 1. Initial event at revision 1, updated at 1000
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Initial Event', 1, 1000, 1000)`,
    ).run();
    const eventId = Number(eventRes.meta.last_row_id);

    const art1 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-init', 'https://example.com/art-init', 'Initial Article', 'Summary', 'shaInit', 'grouped', 1000, 1000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaInit', 'approved', 'admin', 1000)`,
    )
      .bind(art1!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, art1!.id)
      .run();

    // 2. Later, article 2 was approved at t=2000, but grouped into this event at t=3000 bumping revision to 2
    const art2 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, ?1, 'https://example.com/art-late-group', 'https://example.com/art-late-group', 'Late Grouped Breakthrough', 'Breakthrough details', 'shaLate', 'grouped', 2000, 2000)
       RETURNING id`,
    )
      .bind(sourceId)
      .first<{ id: number }>();

    // Approved at 2000
    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'shaLate', 'approved', 'admin', 2000)`,
    )
      .bind(art2!.id)
      .run();

    // Grouped at 3000, bumping event revision to 2 and updated_at to 3000
    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 3000)`,
    )
      .bind(eventId, art2!.id)
      .run();

    await env.DB.prepare(
      `UPDATE events SET revision = 2, updated_at = 3000 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();

    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('late-group-watch', 'Question?', 'Criteria', '["Breakthrough"]', 1, 'active', 1000, 1000)`,
    ).run();

    const mockJudge = vi.fn().mockResolvedValue({ progress: { noul: 0.95 } });
    const mockGenerateText = vi.fn().mockResolvedValue({
      text: "Late grouped article confirmed new breakthrough.",
      finishReason: "STOP",
    });
    const mockModels = {
      judge: mockJudge,
      generateText: mockGenerateText,
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 3000, {
      models: mockModels,
    });

    // Should NOT be misidentified as retraction, should be evaluated as new reporting
    expect(res.evaluatedCount).toBe(1);
    expect(res.hitCount).toBe(1);
    expect(mockJudge).toHaveBeenCalled();
    const judgeState = mockJudge.mock.calls[0][1] as { body: string };
    expect(judgeState.body).toContain("Late Grouped Breakthrough");
  });
});
