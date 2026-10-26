import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  changeArticleIndustry,
  createCorrection,
  reanalyzeArticle,
  updateArticleOverride,
} from "../../src/server/admin/ops";
import { hookBatch } from "../providers/fakes";

describe("article admin operations", () => {
  it("clears overrides as NULL when empty or whitespace", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('art-ind-1', 'Art Ind 1', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S1', 'https://s1.example/feed', 'rss', 'active', 0) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, title_override, summary_override, stage, stage_updated_at, fetched_at)
       VALUES (?1, ?2, 'https://s1.example/art-1', 'https://s1.example/art-1', 'Original Title', 'Initial Override', 'Initial Summary', 'analyzed', 0, 0)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();
    const artId = art!.id;

    // Set whitespace-only overrides -> should become NULL
    await updateArticleOverride(env.DB, {
      articleId: artId,
      titleOverride: "   ",
      summaryOverride: "",
    });

    const row = await env.DB.prepare(
      "SELECT title_override, summary_override FROM articles WHERE id = ?1",
    )
      .bind(artId)
      .first<{
        title_override: string | null;
        summary_override: string | null;
      }>();
    expect(row!.title_override).toBeNull();
    expect(row!.summary_override).toBeNull();
  });

  it("blocks section change with 409 if article is in an event", async () => {
    const ind1 = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('ind-mv-1', 'Ind 1', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const ind2 = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('ind-mv-2', 'Ind 2', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S2', 'https://s2.example/feed', 'rss', 'active', 0) RETURNING id",
    )
      .bind(ind1!.id)
      .first<{ id: number }>();
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, fetched_at)
       VALUES (?1, ?2, 'https://s2.example/art-2', 'https://s2.example/art-2', 'Original Title', 'analyzed', 0, 0)
       RETURNING id`,
    )
      .bind(src!.id, ind1!.id)
      .first<{ id: number }>();
    const artId = art!.id;

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'E1', 1, 0, 0) RETURNING id",
    )
      .bind(ind1!.id)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 0)",
    )
      .bind(event!.id, artId)
      .run();

    // Try to move to ind2
    let error: unknown = null;
    try {
      await changeArticleIndustry(env.DB, {
        articleId: artId,
        industryId: ind2!.id,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(
      error instanceof Response
        ? error.status
        : (error as { status?: number })?.status,
    ).toBe(409);

    const artRow = await env.DB.prepare(
      "SELECT industry_id FROM articles WHERE id = ?1",
    )
      .bind(artId)
      .first<{ industry_id: number }>();
    expect(artRow!.industry_id).toBe(ind1!.id);
  });

  it("moving an auto-approved article to Finance revokes the auto approval", async () => {
    const techInd = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('tech-rev', 'Tech', 'auto', 0) RETURNING id",
    ).first<{ id: number }>();
    const finInd = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('finance', 'Finance', 'review', 0) RETURNING id",
    ).first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S4', 'https://s4.example/feed', 'rss', 'active', 0) RETURNING id",
    )
      .bind(techInd!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://s4.example/art-4', 'https://s4.example/art-4', 'Art 4', 'analyzed', 0, 'sha-4', 0)
       RETURNING id`,
    )
      .bind(src!.id, techInd!.id)
      .first<{ id: number }>();
    const artId = art!.id;

    // Auto approved in Tech
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha-4', 'approved', 'auto', 0)",
    )
      .bind(artId)
      .run();

    // Move to Finance
    await changeArticleIndustry(env.DB, {
      articleId: artId,
      industryId: finInd!.id,
    });

    // Review with reviewer = 'auto' must be deleted
    const reviews = await env.DB.prepare(
      "SELECT count(*) as count FROM reviews WHERE article_id = ?1",
    )
      .bind(artId)
      .first<{ count: number }>();
    expect(reviews!.count).toBe(0);
  });

  it("creates a correction record", async () => {
    await createCorrection(env.DB, {
      targetType: "article",
      targetId: 999,
      body: "Correction text",
    });

    const row = await env.DB.prepare(
      "SELECT target_type, target_id, body FROM corrections WHERE target_id = 999",
    ).first<{ target_type: string; target_id: number; body: string }>();
    expect(row).toEqual({
      target_type: "article",
      target_id: 999,
      body: "Correction text",
    });
  });
});

describe("reanalyzeArticle (#81)", () => {
  let seq = 0;

  /** One article in its own industry; optionally in a revision=1 event. */
  async function seed81(opts: {
    stage: string;
    bodySha: string | null;
    inEvent?: boolean;
  }): Promise<{ id: number; eventId: number | null }> {
    seq += 1;
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES (?1, ?1, 'review', 0) RETURNING id",
    )
      .bind(`ind-81-${seq}`)
      .first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S81', ?2, 'rss', 'active', 0) RETURNING id",
    )
      .bind(ind!.id, `https://s81.example/${seq}/feed`)
      .first<{ id: number }>();
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, requeue_count, body_sha, fetched_at)
       VALUES (?1, ?2, ?3, ?3, 'Original Title', ?4, 0, 3, ?5, 0)
       RETURNING id`,
    )
      .bind(
        src!.id,
        ind!.id,
        `https://s81.example/${seq}/art`,
        opts.stage,
        opts.bodySha,
      )
      .first<{ id: number }>();
    if (!opts.inEvent) return { id: art!.id, eventId: null };
    const ev = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'E81', 1, 0, 0) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 0)",
    )
      .bind(ev!.id, art!.id)
      .run();
    return { id: art!.id, eventId: ev!.id };
  }

  function queue() {
    const sent: unknown[] = [];
    const q = {
      send: async (m: unknown) => {
        sent.push(m);
      },
    };
    return { sent, q };
  }

  const articleState = (id: number) =>
    env.DB.prepare(
      "SELECT stage, stage_updated_at, requeue_count, analysis_generation FROM articles WHERE id = ?1",
    )
      .bind(id)
      .first<{
        stage: string;
        stage_updated_at: number;
        requeue_count: number;
        analysis_generation: number;
      }>();

  const revisionOf = async (eventId: number) =>
    (await env.DB.prepare("SELECT revision FROM events WHERE id = ?1")
      .bind(eventId)
      .first<{ revision: number }>())!.revision;

  /** The HTTP status of what `p` throws; null if it resolves. */
  async function statusOf(p: Promise<unknown>): Promise<number | null> {
    try {
      await p;
      return null;
    } catch (e) {
      return e instanceof Response
        ? e.status
        : ((e as { status?: number })?.status ?? -1);
    }
  }

  it("keeps every llm_calls and analyses row, bumps the generation and the event revision once", async () => {
    const { id, eventId } = await seed81({
      stage: "analyzed",
      bodySha: "sha-a",
      inEvent: true,
    });
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, selected, created_at)
       VALUES (?1, 'v1', '{}', 'news', '{}', 80, 1, 0),
              (?1, 'primary_tracker', '{}', 'news', '{}', 0, 0, 0)`,
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      `INSERT INTO llm_calls (logical_key, slot, model, channel, status, attempt, failures, sent_at, estimated_micros, budget_day, created_at, updated_at)
       VALUES (?1, 'analyze', 'm', 'gateway', 'completed', 1, 0, 1, NULL, NULL, 0, 0),
              (?2, 'write', 'm', 'gateway', 'failed', 3, 3, NULL, NULL, NULL, 0, 0),
              (?3, 'write', 'm', 'gateway', 'in_flight', 1, 0, 1, 500, '2026-10-26', 0, 0)`,
    )
      // Template literals, not SQL `||`: D1 binds a JS number as a real, so
      // `'a:' || ?1` would yield "a:1.0" and never match a production key.
      .bind(`analyze:${id}:abc:v1`, `write:${id}:abc:v1`, `write:${id}:old:v1`)
      .run();
    await env.DB.prepare(
      "INSERT INTO budgets (day, channel, cap_micros, reserved_micros) VALUES ('2026-10-26', 'gateway', 1900000, 500)",
    ).run();
    const ledger = () =>
      env.DB.prepare(
        `SELECT logical_key, status, attempt, failures FROM llm_calls
         WHERE logical_key LIKE ?1 ORDER BY logical_key`,
      )
        .bind(`%:${id}:%`)
        .all()
        .then((r) => r.results);
    const before = await ledger();
    expect(before).toHaveLength(3);

    const { sent, q } = queue();
    await reanalyzeArticle(env.DB, q, {
      articleId: id,
      expectedStage: "analyzed",
    });

    expect(await ledger()).toEqual(before);
    const budget = await env.DB.prepare(
      "SELECT reserved_micros FROM budgets WHERE day = '2026-10-26' AND channel = 'gateway'",
    ).first<{ reserved_micros: number }>();
    expect(budget!.reserved_micros).toBe(500);
    const analyses = await env.DB.prepare(
      "SELECT prompt_version FROM analyses WHERE article_id = ?1 ORDER BY prompt_version",
    )
      .bind(id)
      .all<{ prompt_version: string }>();
    expect(analyses.results.map((r) => r.prompt_version)).toEqual([
      "primary_tracker",
      "v1",
    ]);
    const art = await articleState(id);
    expect(art).toMatchObject({
      stage: "body_ready",
      requeue_count: 0,
      analysis_generation: 1,
    });
    expect(art!.stage_updated_at).toBeGreaterThan(0);
    expect(await revisionOf(eventId!)).toBe(2);
    expect(sent).toEqual([{ kind: "analyze", articleId: id }]);
  });

  it("expected stage does not match: 409, nothing written, no message", async () => {
    const { id, eventId } = await seed81({
      stage: "grouped",
      bodySha: "sha-g",
      inEvent: true,
    });
    const { sent, q } = queue();
    expect(
      await statusOf(
        reanalyzeArticle(env.DB, q, {
          articleId: id,
          expectedStage: "analyzed",
        }),
      ),
    ).toBe(409);
    expect(await articleState(id)).toEqual({
      stage: "grouped",
      stage_updated_at: 0,
      requeue_count: 3,
      analysis_generation: 0,
    });
    expect(await revisionOf(eventId!)).toBe(1);
    expect(sent).toEqual([]);
  });

  it("a concurrent reanalysis between the read and the write: the generation fence writes nothing", async () => {
    const { id, eventId } = await seed81({
      stage: "body_ready",
      bodySha: "sha-r",
      inEvent: true,
    });
    // Another reanalysis lands after reanalyzeArticle read the generation
    // and before its batch() runs.
    const racing = hookBatch(async (_n, run) => {
      await env.DB.prepare(
        "UPDATE articles SET analysis_generation = analysis_generation + 1 WHERE id = ?1",
      )
        .bind(id)
        .run();
      return run();
    });
    const { sent, q } = queue();
    expect(
      await statusOf(
        reanalyzeArticle(racing, q, {
          articleId: id,
          expectedStage: "body_ready",
        }),
      ),
    ).toBe(409);
    expect((await articleState(id))!.analysis_generation).toBe(1);
    expect(await revisionOf(eventId!)).toBe(1);
    expect(sent).toEqual([]);
  });

  it("an article without a body or a missing article is refused", async () => {
    const { sent, q } = queue();

    const a = await seed81({ stage: "analyzed", bodySha: null });
    expect(
      await statusOf(
        reanalyzeArticle(env.DB, q, {
          articleId: a.id,
          expectedStage: "analyzed",
        }),
      ),
    ).toBe(409);
    expect(await articleState(a.id)).toMatchObject({
      stage: "analyzed",
      analysis_generation: 0,
    });

    const b = await seed81({ stage: "collected", bodySha: null });
    expect(
      await statusOf(
        reanalyzeArticle(env.DB, q, {
          articleId: b.id,
          expectedStage: "collected",
        }),
      ),
    ).toBe(409);
    expect(await articleState(b.id)).toMatchObject({
      stage: "collected",
      analysis_generation: 0,
    });

    expect(
      await statusOf(
        reanalyzeArticle(env.DB, q, {
          articleId: 999_999,
          expectedStage: "analyzed",
        }),
      ),
    ).toBe(404);
    expect(sent).toEqual([]);
  });

  // Defect witnesses (#81): red on the code before the fix for the defect
  // itself, not for a missing interface. No analysis_generation reads here.
  it("defect witness: reanalysis keeps the earlier llm_calls and analyses rows", async () => {
    const { id: artId } = await seed81({
      stage: "analyzed",
      bodySha: "sha-w1",
    });
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, selected, created_at)
       VALUES (?1, 'v1', '{}', 'news', '{}', 80, 1, 0),
              (?1, 'primary_tracker', '{}', 'news', '{}', 0, 0, 0)`,
    )
      .bind(artId)
      .run();
    await env.DB.prepare(
      `INSERT INTO llm_calls (logical_key, slot, model, channel, status, attempt, failures, sent_at, created_at, updated_at)
       VALUES (?1, 'analyze', 'm', 'gateway', 'completed', 1, 0, 1, 0, 0),
              (?2, 'write', 'm', 'gateway', 'in_flight', 1, 0, 1, 0, 0)`,
    )
      .bind(`analyze:${artId}:w1:v1`, `write:${artId}:w1:v1`)
      .run();
    const rows = async () => ({
      calls: (
        await env.DB.prepare(
          `SELECT logical_key, status FROM llm_calls
           WHERE logical_key LIKE ?1 ORDER BY logical_key`,
        )
          .bind(`%:${artId}:%`)
          .all()
      ).results,
      analyses: (
        await env.DB.prepare(
          "SELECT prompt_version FROM analyses WHERE article_id = ?1 ORDER BY prompt_version",
        )
          .bind(artId)
          .all()
      ).results,
    });
    const before = await rows();
    expect(before.calls).toHaveLength(2);
    expect(before.analyses).toHaveLength(2);

    await reanalyzeArticle(env.DB, env.Q_INGEST, {
      articleId: artId,
      expectedStage: "analyzed",
    });

    expect(await rows()).toEqual(before);
  });

  it("defect witness: the stage write is conditional on the stage the admin saw", async () => {
    // The admin saw the article as analyzed; it has since moved to grouped.
    const { id: artId, eventId } = await seed81({
      stage: "grouped",
      bodySha: "sha-w2",
      inEvent: true,
    });
    const changes: number[] = [];
    const watched = hookBatch(async (_n, run) => {
      const results = await run();
      for (const r of results) changes.push(r.meta.changes);
      return results;
    });
    const { sent, q } = queue();

    // Old or new signature, refused or not: only the writes are checked.
    await statusOf(
      reanalyzeArticle(watched, q, {
        articleId: artId,
        expectedStage: "analyzed",
      }),
    );

    expect(changes.length).toBeGreaterThan(0);
    expect(changes).toEqual(changes.map(() => 0));
    expect(
      await env.DB.prepare(
        "SELECT stage, stage_updated_at, requeue_count FROM articles WHERE id = ?1",
      )
        .bind(artId)
        .first(),
    ).toEqual({ stage: "grouped", stage_updated_at: 0, requeue_count: 3 });
    expect(await revisionOf(eventId!)).toBe(1);
    expect(sent).toEqual([]);
  });
});
