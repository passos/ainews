import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  changeArticleIndustry,
  createCorrection,
  reanalyzeArticle,
  updateArticleOverride,
} from "../../src/server/admin/ops";

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

  it("reanalyzing an article clears old analyses and resets stage to body_ready", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('ind-re-1', 'Ind Re', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S3', 'https://s3.example/feed', 'rss', 'active', 0) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, requeue_count, fetched_at)
       VALUES (?1, ?2, 'https://s3.example/art-3', 'https://s3.example/art-3', 'Original Title', 'analyzed', 0, 3, 0)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();
    const artId = art!.id;

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, selected, created_at)
       VALUES (?1, 'v1', '{}', 'news', '{}', 80, 1, 0)`,
    )
      .bind(artId)
      .run();

    await reanalyzeArticle(env.DB, env.Q_INGEST, artId);

    const artRow = await env.DB.prepare(
      "SELECT stage, requeue_count FROM articles WHERE id = ?1",
    )
      .bind(artId)
      .first<{ stage: string; requeue_count: number }>();
    expect(artRow!.stage).toBe("body_ready");
    expect(artRow!.requeue_count).toBe(0);

    const analysesCount = await env.DB.prepare(
      "SELECT count(*) as count FROM analyses WHERE article_id = ?1",
    )
      .bind(artId)
      .first<{ count: number }>();
    expect(analysesCount!.count).toBe(0);
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
