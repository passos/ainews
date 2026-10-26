import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateEventWatches,
  markWatchEvaluated,
} from "../../src/pipeline/watch/evaluate";
import { enqueueDueWatches } from "../../src/pipeline/watch/schedule";
import {
  BudgetExceededError,
  CallFailedError,
  type ModelClient,
} from "../../src/providers/models";

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
       VALUES ('tech-watch', 'Question?', 'Criteria', '["AI"]', 1, 'active', 500, 500)`,
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
       VALUES ('biotech-watch', 'Cancer drug discoveries', 'Criteria', '["oncology", "clinical trial"]', 1, 'active', 500, 500)`,
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
       VALUES ('gpt-5-idem', 'GPT-5 Benchmarks', 'Criteria', '["benchmark", "gpt-5"]', 1, 'active', 500, 500)`,
    ).run();
    const watchId = Number(watchRes.meta.last_row_id);

    // Pre-insert hit for revision 2 that cites the only new article
    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 2, 1000, 'Prior summary', ?3)`,
    )
      .bind(watchId, eventId, JSON.stringify({ articleIds: [articleId] }))
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
       VALUES ('gpu-pricing', 'Official GPU Pricing', 'Must be official manufacturer announcement', '["GPU", "pricing"]', 1, 'active', 500, 500)`,
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
       VALUES ('official-blackwell', 'Official Blackwell Pricing', 'Must be official manufacturer announcement', '["Blackwell", "pricing"]', 1, 'active', 500, 500)`,
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
       VALUES ('enqueue-watch', 'Question?', 'Criteria', '["active"]', 1, 'active', 500, 500)`,
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
       VALUES ('breakthrough-watch', 'Model Releases', 'Must be a new model release', '["Breakthrough", "Model"]', 1, 'active', 500, 500)
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
       VALUES ('criteria-key-test', 'Fab Status', 'Initial criteria A', '["Fab"]', 1, 'active', 500, 500)
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
    // This test checks the key composition, not re-evaluation: clear the
    // revision marker so the second call evaluates again.
    await env.DB.prepare(
      `UPDATE events SET watch_evaluated_revision = 0, watch_evaluated_through = NULL WHERE id = ?1`,
    )
      .bind(eventId)
      .run();
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
       VALUES ('empty-kw-watch', 'Question?', 'Criteria', '[]', 1, 'active', 500, 500)`,
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
       VALUES ('csharp-watch', 'C# Updates', 'Criteria', '["C#"]', 1, 'active', 500, 500)`,
    ).run();

    // 2. Symbol keyword ".NET"
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('dotnet-watch', '.NET Updates', 'Criteria', '[".NET"]', 1, 'active', 500, 500)`,
    ).run();

    // 3. Word-bounded "AI" should NOT match "chain"
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('ai-watch', 'AI Updates', 'Criteria', '["AI"]', 1, 'active', 500, 500)`,
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
       VALUES ('trunc-watch', 'Benchmark Results', 'Empirical numbers', '["Benchmark"]', 1, 'active', 500, 500)
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
       VALUES ('late-group-watch', 'Question?', 'Criteria', '["Breakthrough"]', 1, 'active', 500, 500)`,
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

describe("pipeline: watch hit status and revision marker (#85)", () => {
  let sourceId: number;

  beforeEach(async () => {
    // Scheduling assertions count every due event, so start each test
    // without events from earlier tests in this file.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM watch_hits`),
      env.DB.prepare(`DELETE FROM watches`),
      env.DB.prepare(`DELETE FROM event_articles`),
      env.DB.prepare(`DELETE FROM events`),
    ]);
    await env.DB.prepare(
      `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
       VALUES (1, 'tech', 'Tech', 'review', '[]', '{}', 1, 1000)
       ON CONFLICT DO NOTHING`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (1, 'Test Source', 'https://example.com/feed.xml', 'example.com', 'rss', 'active', 1000)
       ON CONFLICT DO NOTHING`,
    ).run();
    sourceId = (await env.DB.prepare(
      `SELECT id FROM sources WHERE feed_url = 'https://example.com/feed.xml'`,
    ).first<{ id: number }>())!.id;
  });

  async function seedIndustry(
    slug: string,
    publishMode: "auto" | "review",
  ): Promise<number> {
    const row = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, primary_domains, config, config_version, created_at)
       VALUES (?1, ?1, ?2, '[]', '{}', 1, 1000)
       ON CONFLICT (slug) DO UPDATE SET publish_mode = excluded.publish_mode
       RETURNING id`,
    )
      .bind(slug, publishMode)
      .first<{ id: number }>();
    return row!.id;
  }

  async function seedEvent(
    industryId: number,
    revision: number,
    updatedAt: number,
  ): Promise<number> {
    const row = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (?1, 'Marker Event', ?2, ?3, ?3) RETURNING id`,
    )
      .bind(industryId, revision, updatedAt)
      .first<{ id: number }>();
    return row!.id;
  }

  /** An approved article in the event; its effective_at is `at`. */
  async function seedApproved(
    eventId: number,
    industryId: number,
    title: string,
    at: number,
  ): Promise<number> {
    const url = `https://example.com/marker/${crypto.randomUUID()}`;
    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (?1, ?2, ?3, ?3, ?4, 'Summary', 'sha-marker', 'grouped', ?5, ?5)
       RETURNING id`,
    )
      .bind(industryId, sourceId, url, title, at)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha-marker', 'approved', 'admin', ?2)`,
    )
      .bind(art!.id, at)
      .run();
    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, ?3)`,
    )
      .bind(eventId, art!.id, at)
      .run();
    return art!.id;
  }

  async function seedWatch(
    slug: string,
    industryId: number | null = null,
    createdAt = 500,
  ) {
    const row = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES (?1, 'Marker question?', 'Marker criteria', '["Marker"]', ?2, 'active', ?3, ?3)
       RETURNING id`,
    )
      .bind(slug, industryId, createdAt)
      .first<{ id: number }>();
    return row!.id;
  }

  function models(noul: number) {
    const judge = vi.fn().mockResolvedValue({ progress: { noul } });
    const generateText = vi
      .fn()
      .mockResolvedValue({ text: "Marker progress.", finishReason: "STOP" });
    return {
      judge,
      generateText,
      client: { judge, generateText } as unknown as ModelClient,
    };
  }

  function queue() {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    return {
      sendBatch,
      env: { DB: env.DB, Q_GENERATE: { sendBatch } as unknown as Queue },
    };
  }

  async function marker(eventId: number) {
    return env.DB.prepare(
      `SELECT watch_evaluated_revision AS revision, watch_evaluated_through AS through
       FROM events WHERE id = ?1`,
    )
      .bind(eventId)
      .first<{ revision: number; through: number | null }>();
  }

  async function hitStatusFor(industryId: number): Promise<string | null> {
    const eventId = await seedEvent(industryId, 1, 1000);
    await seedApproved(eventId, industryId, "Marker article", 1000);
    await seedWatch(`status-${crypto.randomUUID().slice(0, 8)}`);
    const m = models(0.9);
    await evaluateEventWatches(env, eventId, 1000, { models: m.client });
    const row = await env.DB.prepare(
      `SELECT status FROM watch_hits WHERE event_id = ?1`,
    )
      .bind(eventId)
      .first<{ status: string }>();
    return row?.status ?? null;
  }

  it("stores a Finance hit as pending_review even when the section publish_mode is auto", async () => {
    const finance = await seedIndustry("finance", "auto");
    expect(await hitStatusFor(finance)).toBe("pending_review");
  });

  it("stores a hit in a review section as pending_review", async () => {
    const review = await seedIndustry("review-section", "review");
    expect(await hitStatusFor(review)).toBe("pending_review");
  });

  // Ruling 1 (#85): a hit's summary and rationale are model-written text, so
  // every section reviews it first, auto sections included.
  it("stores a hit in an auto non-Finance section as pending_review", async () => {
    const auto = await seedIndustry("auto-section", "auto");
    expect(await hitStatusFor(auto)).toBe("pending_review");
  });

  it("does not call the judge again for an event revision that was already evaluated", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article", 1000);
    await seedWatch("s1-watch");
    const m = models(0.1);

    await evaluateEventWatches(env, eventId, 1000, { models: m.client });
    await evaluateEventWatches(env, eventId, 1000, { models: m.client });

    expect(m.judge).toHaveBeenCalledTimes(1);
    expect((await marker(eventId))!.revision).toBe(1);

    // The scheduler does not pick the evaluated revision again either.
    const q = queue();
    expect(await enqueueDueWatches(q.env, 1000)).toEqual([]);
  });

  it("skips a revision whose marker is current even when no reporting boundary is set", async () => {
    // A marker without a boundary: the last evaluation found no approved
    // article. The marker alone must stop a second evaluation.
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article", 1000);
    await seedWatch("s1b-watch");
    await env.DB.prepare(
      `UPDATE events SET watch_evaluated_revision = 1, watch_evaluated_through = NULL WHERE id = ?1`,
    )
      .bind(eventId)
      .run();
    const m = models(0.9);

    const res = await evaluateEventWatches(env, eventId, 1000, {
      models: m.client,
    });

    expect(res.evaluatedCount).toBe(0);
    expect(m.judge).not.toHaveBeenCalled();
  });

  it("enqueueDueWatches reaches events beyond the first page and outside any time window", async () => {
    const now = 100_000_000;
    const old = now - 2 * 3600 * 1000;
    const created: number[] = [];
    for (let i = 0; i < 21; i++) {
      // Distinct updated_at: the newest 20 come first.
      const eventId = await seedEvent(1, 1, old + i);
      await seedApproved(eventId, 1, `Marker article ${i}`, old + i);
      created.push(eventId);
    }
    await seedWatch("s2-watch");
    const m = models(0.1);

    const q = queue();
    const first = await enqueueDueWatches(q.env, now, 20);
    expect(first.length).toBe(20);
    expect(first.every((id) => created.includes(id))).toBe(true);

    for (const eventId of first) {
      await evaluateEventWatches(env, eventId, now, { models: m.client });
    }

    const second = await enqueueDueWatches(q.env, now, 20);
    expect(second).toEqual(created.filter((id) => !first.includes(id)));

    await evaluateEventWatches(env, second[0], now, { models: m.client });
    expect(await enqueueDueWatches(q.env, now, 20)).toEqual([]);
  });

  it("enqueueDueWatches enqueues an event again after its revision increases", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article", 1000);
    await seedWatch("s3-watch");
    const m = models(0.1);
    const q = queue();

    expect(await enqueueDueWatches(q.env, 1000)).toEqual([eventId]);
    await evaluateEventWatches(env, eventId, 1000, { models: m.client });
    expect(await enqueueDueWatches(q.env, 1000)).toEqual([]);

    await env.DB.prepare(
      `UPDATE events SET revision = revision + 1 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();
    expect(await enqueueDueWatches(q.env, 1000)).toEqual([eventId]);
  });

  it("enqueueDueWatches enqueues and evaluate marks events when no watch is active", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article", 1000);
    const m = models(0.9);
    const q = queue();

    expect(await enqueueDueWatches(q.env, 1000)).toEqual([eventId]);
    await evaluateEventWatches(env, eventId, 1000, { models: m.client });
    expect((await marker(eventId))!.revision).toBe(1);
    expect(m.judge).not.toHaveBeenCalled();
    expect(await enqueueDueWatches(q.env, 1000)).toEqual([]);
  });

  it("treats articles approved across two unevaluated revisions as new reporting", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article A", 1000);
    await seedWatch("s5-watch");
    const m = models(0.1);
    await evaluateEventWatches(env, eventId, 1000, { models: m.client });

    // Two approvals before the next evaluation: revision 1 -> 3.
    await seedApproved(eventId, 1, "Marker article B", 2000);
    await seedApproved(eventId, 1, "Marker article C", 3000);
    await env.DB.prepare(
      `UPDATE events SET revision = 3, updated_at = 3000 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();

    m.judge.mockClear();
    await evaluateEventWatches(env, eventId, 3000, { models: m.client });

    expect(m.judge).toHaveBeenCalledTimes(1);
    const body = (m.judge.mock.calls[0][1] as { body: string }).body;
    const [newPart, priorPart = ""] = body.split(
      "=== PRIOR REPORTING (ALREADY KNOWN) ===",
    );
    expect(newPart).toContain("=== NEW REPORTING IN THIS UPDATE ===");
    expect(newPart).toContain("Marker article B");
    expect(newPart).toContain("Marker article C");
    expect(newPart).not.toContain("Marker article A");
    expect(priorPart).toContain("Marker article A");
  });

  it("skips a watch whose judge call is exhausted and still marks the revision", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article", 1000);
    const w1 = await seedWatch("s6-watch-1");
    const w2 = await seedWatch("s6-watch-2");
    const m = models(0.9);
    m.judge.mockImplementation(async (key: string) => {
      if (key.startsWith(`watch:judge:${w1}:`)) {
        throw new CallFailedError(key, "x");
      }
      return { progress: { noul: 0.9 } };
    });

    await expect(
      evaluateEventWatches(env, eventId, 1000, { models: m.client }),
    ).resolves.toBeDefined();

    const { results: hits } = await env.DB.prepare(
      `SELECT watch_id FROM watch_hits WHERE event_id = ?1`,
    )
      .bind(eventId)
      .all<{ watch_id: number }>();
    expect(hits.map((h) => h.watch_id)).toEqual([w2]);
    expect((await marker(eventId))!.revision).toBe(1);
  });

  it("records the hit with the fallback summary when the write call is exhausted", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article", 1000);
    await seedWatch("s6b-watch");
    const m = models(0.9);
    m.generateText.mockImplementation(async (_slot: string, key: string) => {
      throw new CallFailedError(key, "x");
    });

    await evaluateEventWatches(env, eventId, 1000, { models: m.client });

    const hit = await env.DB.prepare(
      `SELECT summary FROM watch_hits WHERE event_id = ?1`,
    )
      .bind(eventId)
      .first<{ summary: string }>();
    expect(hit?.summary).toBe("Marker article");
    expect((await marker(eventId))!.revision).toBe(1);
  });

  it("keeps the marker behind when the judge throws BudgetExceededError", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article", 1000);
    await seedWatch("s7-watch");
    const m = models(0.9);
    m.judge.mockRejectedValue(
      new BudgetExceededError("gateway", "2026-10-26", 1),
    );

    await expect(
      evaluateEventWatches(env, eventId, 1000, { models: m.client }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect((await marker(eventId))!.revision).toBe(0);
  });

  it("markWatchEvaluated never moves the marker backwards", async () => {
    const eventId = await seedEvent(1, 3, 1000);
    await env.DB.prepare(
      `UPDATE events SET watch_evaluated_revision = 3, watch_evaluated_through = 500 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();

    await markWatchEvaluated(env.DB, eventId, 2, 100);
    expect(await marker(eventId)).toEqual({ revision: 3, through: 500 });

    // A revision with no new reporting (an article left the event) keeps
    // the boundary where it was.
    const ev2 = await seedEvent(1, 1, 2000);
    await seedApproved(ev2, 1, "Marker article A", 1000);
    const later = await seedApproved(ev2, 1, "Marker article B", 2000);
    await seedWatch("s8-watch");
    const m = models(0.1);
    await evaluateEventWatches(env, ev2, 2000, { models: m.client });
    expect(await marker(ev2)).toEqual({ revision: 1, through: 2000 });

    await env.DB.prepare(`DELETE FROM event_articles WHERE article_id = ?1`)
      .bind(later)
      .run();
    await env.DB.prepare(
      `UPDATE events SET revision = 2, updated_at = 4000 WHERE id = ?1`,
    )
      .bind(ev2)
      .run();
    m.judge.mockClear();
    await evaluateEventWatches(env, ev2, 4000, { models: m.client });
    expect(m.judge).not.toHaveBeenCalled();
    expect(await marker(ev2)).toEqual({ revision: 2, through: 2000 });
  });

  async function hitsOf(eventId: number) {
    const { results } = await env.DB.prepare(
      `SELECT watch_id, event_revision, rationale FROM watch_hits
       WHERE event_id = ?1 ORDER BY id`,
    )
      .bind(eventId)
      .all<{ watch_id: number; event_revision: number; rationale: string }>();
    return results.map((h) => ({
      watchId: h.watch_id,
      revision: h.event_revision,
      articleIds: (JSON.parse(h.rationale) as { articleIds: number[] })
        .articleIds,
    }));
  }

  // A hit records "a development at revision R" and does not expire
  // (invariant 3), so a concurrent bump must not drop it.
  it("keeps the hit when the event revision is bumped while the judge runs", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    const b = await seedApproved(eventId, 1, "Marker article B", 1000);
    const w = await seedWatch("f1-watch");
    const m = models(0.9);
    m.judge.mockImplementation(async () => {
      // An approval lands between the judge call and the hit insert.
      await env.DB.prepare(
        `UPDATE events SET revision = revision + 1 WHERE id = ?1`,
      )
        .bind(eventId)
        .run();
      return { progress: { noul: 0.9 } };
    });

    await evaluateEventWatches(env, eventId, 1000, { models: m.client });
    expect(await hitsOf(eventId)).toEqual([
      { watchId: w, revision: 1, articleIds: [b] },
    ]);

    // Revision 2 brings nothing new: B is prior reporting, no second hit.
    m.judge.mockReset();
    m.judge.mockResolvedValue({ progress: { noul: 0.9 } });
    await evaluateEventWatches(env, eventId, 2000, { models: m.client });
    expect(m.judge).not.toHaveBeenCalled();
    expect(await hitsOf(eventId)).toEqual([
      { watchId: w, revision: 1, articleIds: [b] },
    ]);
  });

  it("does not hit again on an article that an earlier unmarked revision already hit", async () => {
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article A", 1000);
    const w1 = await seedWatch("f3-watch-1");
    const w2 = await seedWatch("f3-watch-2");
    const m = models(0.1);
    await evaluateEventWatches(env, eventId, 1000, { models: m.client });

    // Revision 2: W1 hits B, W2 fails with a retryable error.
    const b = await seedApproved(eventId, 1, "Marker article B", 2000);
    await env.DB.prepare(
      `UPDATE events SET revision = 2, updated_at = 2000 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();
    m.judge.mockReset();
    m.judge.mockImplementation(async (key: string) => {
      if (key.startsWith(`watch:judge:${w2}:`)) {
        throw new BudgetExceededError("gateway", "2026-10-26", 1);
      }
      return { progress: { noul: 0.9 } };
    });
    await expect(
      evaluateEventWatches(env, eventId, 2000, { models: m.client }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect((await marker(eventId))!.revision).toBe(1);
    expect(await hitsOf(eventId)).toEqual([
      { watchId: w1, revision: 2, articleIds: [b] },
    ]);

    // Revision 3 adds C; the retry evaluates it.
    const c = await seedApproved(eventId, 1, "Marker article C", 3000);
    await env.DB.prepare(
      `UPDATE events SET revision = 3, updated_at = 3000 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();
    m.judge.mockReset();
    m.judge.mockResolvedValue({ progress: { noul: 0.9 } });
    await evaluateEventWatches(env, eventId, 3000, { models: m.client });

    const w1Call = m.judge.mock.calls.find((call) =>
      (call[0] as string).startsWith(`watch:judge:${w1}:`),
    );
    const [newPart, priorPart = ""] = (
      w1Call![1] as { body: string }
    ).body.split("=== PRIOR REPORTING (ALREADY KNOWN) ===");
    expect(newPart).toContain("Marker article C");
    expect(newPart).not.toContain("Marker article B");
    expect(priorPart).toContain("Marker article B");

    const hits = await hitsOf(eventId);
    expect(hits.filter((h) => h.watchId === w1)).toEqual([
      { watchId: w1, revision: 2, articleIds: [b] },
      { watchId: w1, revision: 3, articleIds: [c] },
    ]);
    // W2 never hit before, so B and C are both new to it.
    expect(hits.filter((h) => h.watchId === w2)).toEqual([
      { watchId: w2, revision: 3, articleIds: [b, c] },
    ]);
  });

  it("does not judge articles approved before the watch was created", async () => {
    // t=1000 approve, t=2000 create the watch, t=3000 consume the event.
    const eventId = await seedEvent(1, 1, 1000);
    await seedApproved(eventId, 1, "Marker article", 1000);
    await seedWatch("f4-watch", null, 2000);
    const m = models(0.9);

    const res = await evaluateEventWatches(env, eventId, 3000, {
      models: m.client,
    });

    expect(m.judge).not.toHaveBeenCalled();
    expect(res.evaluatedCount).toBe(0);
    expect(await hitsOf(eventId)).toEqual([]);
    expect((await marker(eventId))!.revision).toBe(1);
  });

  it("keys the judge call on the articles it actually sees (hit history changes the key)", async () => {
    // Same event, same revision, same watch. A hit on B lands between the
    // two evaluations, so the second call judges A only: its ledger key
    // must differ, or the ledger would serve the first call's answer.
    const eventId = await seedEvent(1, 1, 2000);
    await seedApproved(eventId, 1, "Marker article A", 1000);
    const b = await seedApproved(eventId, 1, "Marker article B", 2000);
    const w = await seedWatch("ledger-key-watch");
    const m = models(0.1);

    await evaluateEventWatches(env, eventId, 2000, { models: m.client });
    const firstKey = m.judge.mock.calls[0][0] as string;

    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale, status)
       VALUES (?1, ?2, 1, 2000, 'Marker hit', ?3, 'pending_review')`,
    )
      .bind(w, eventId, JSON.stringify({ articleIds: [b] }))
      .run();
    // Re-open the same revision (the criteria-key test does the same).
    await env.DB.prepare(
      `UPDATE events SET watch_evaluated_revision = 0, watch_evaluated_through = NULL WHERE id = ?1`,
    )
      .bind(eventId)
      .run();
    m.judge.mockClear();
    await evaluateEventWatches(env, eventId, 2000, { models: m.client });

    expect(m.judge).toHaveBeenCalledTimes(1);
    expect(m.judge.mock.calls[0][0]).not.toEqual(firstKey);
  });

  it("marks a first-evaluated retraction revision without calling the judge", async () => {
    // Revision 2, never evaluated, newest approval older than updated_at.
    const eventId = await seedEvent(1, 2, 20000);
    await seedApproved(eventId, 1, "Marker article", 10000);
    await seedWatch("c1-watch");
    const m = models(0.9);

    await evaluateEventWatches(env, eventId, 20000, { models: m.client });

    expect(m.judge).not.toHaveBeenCalled();
    expect(await marker(eventId)).toEqual({ revision: 2, through: 10000 });
  });

  it("marks an event that has no approved article", async () => {
    const eventId = await seedEvent(1, 2, 1000);
    await seedWatch("c3-watch");
    const m = models(0.9);

    await evaluateEventWatches(env, eventId, 1000, { models: m.client });

    expect(m.judge).not.toHaveBeenCalled();
    expect(await marker(eventId)).toEqual({ revision: 2, through: null });
  });

  // #92 ruling 1: watch is the third kind of enqueueDueEvents. Nested here to
  // reuse this block's beforeEach (it deletes all events) and seed helpers.
  describe("watch scheduling (#92)", () => {
    it("enqueueDueWatches rotates by last enqueue time", async () => {
      const ids: number[] = [];
      for (let i = 0; i <= 20; i++) {
        const eventId = await seedEvent(1, 1, 1000 + i);
        await seedApproved(eventId, 1, `Rotation article ${i}`, 1000 + i);
        ids.push(eventId);
      }

      const first = await enqueueDueWatches(queue().env, 2000, 20);
      expect(first).toEqual(ids.slice(0, 20));

      const { results } = await env.DB.prepare(
        `SELECT id, watch_scheduled_at, updated_at, revision FROM events
         WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id ASC`,
      )
        .bind(JSON.stringify(first))
        .all<{
          id: number;
          watch_scheduled_at: number;
          updated_at: number;
          revision: number;
        }>();
      expect(results).toEqual(
        first.map((id, i) => ({
          id,
          watch_scheduled_at: 2000,
          updated_at: 1000 + i,
          revision: 1,
        })),
      );

      const second = await enqueueDueWatches(queue().env, 3000, 20);
      expect(second[0]).toBe(ids[20]);
    });
  });
});
