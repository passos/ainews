import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  decideReview,
  listPendingArticles,
  updateIndustryConfig,
} from "../../src/server/admin/ops";

describe("review and industry admin operations", () => {
  it("approval binds to body_sha; returning 409 on sha mismatch and returning to queue when body changes", async () => {
    // 1. Setup seed industry and source and article
    const indRes = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('test-ind', 'Test Industry', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const indId = indRes!.id;

    const srcRes = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Test Source', 'https://example.com/feed', 'rss', 'active', 0) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = srcRes!.id;

    const artRes = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://example.com/art1', 'https://example.com/art1', 'Article 1', 'analyzed', 0, 'sha-A', 0)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    const artId = artRes!.id;

    // 2. Query pending articles: artId should be present
    const pending1 = await listPendingArticles(env.DB, { industryId: indId });
    expect(pending1.some((a) => a.id === artId)).toBe(true);

    // 3. Submitting mismatched bodySha should throw 409 and not change reviews count
    let error: unknown = null;
    try {
      await decideReview(env.DB, {
        articleId: artId,
        bodySha: "sha-WRONG",
        decision: "approved",
        reviewer: "admin@example.com",
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

    const reviewsCount1 = await env.DB.prepare(
      "SELECT count(*) as count FROM reviews WHERE article_id = ?1",
    )
      .bind(artId)
      .first<{ count: number }>();
    expect(reviewsCount1!.count).toBe(0);

    // 4. Approve with matching bodySha = 'sha-A'
    await decideReview(env.DB, {
      articleId: artId,
      bodySha: "sha-A",
      decision: "approved",
      reviewer: "admin@example.com",
    });

    // Article should now NOT be in pending list
    const pending2 = await listPendingArticles(env.DB, { industryId: indId });
    expect(pending2.some((a) => a.id === artId)).toBe(false);

    // 5. Change article body_sha to 'sha-B'
    await env.DB.prepare("UPDATE articles SET body_sha = 'sha-B' WHERE id = ?1")
      .bind(artId)
      .run();

    // 6. Article should be back in pending list because approval was for sha-A
    const pending3 = await listPendingArticles(env.DB, { industryId: indId });
    expect(pending3.some((a) => a.id === artId)).toBe(true);
  });

  it("rejects publish_mode = 'auto' for Finance section", async () => {
    const finRes = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('finance', 'Finance', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const finId = finRes!.id;

    let error: unknown = null;
    try {
      await updateIndustryConfig(env.DB, {
        id: finId,
        publishMode: "auto",
        primaryDomains: [],
        config: "{}",
        disclaimer: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(
      error instanceof Response
        ? error.status
        : (error as { status?: number })?.status,
    ).toBe(400);

    const finRow = await env.DB.prepare(
      "SELECT publish_mode FROM industries WHERE id = ?1",
    )
      .bind(finId)
      .first<{ publish_mode: string }>();
    expect(finRow!.publish_mode).toBe("review");
  });

  it("rejects empty disclaimer for Finance section", async () => {
    let fin = await env.DB.prepare(
      "SELECT id FROM industries WHERE slug = 'finance'",
    ).first<{ id: number }>();
    if (!fin) {
      fin = await env.DB.prepare(
        "INSERT INTO industries (slug, name, publish_mode, disclaimer, created_at) VALUES ('finance', 'Finance Disc', 'review', 'Legal disclaimer', 0) RETURNING id",
      ).first<{ id: number }>();
    }
    const finId = fin!.id;

    let error: unknown = null;
    try {
      await updateIndustryConfig(env.DB, {
        id: finId,
        publishMode: "review",
        primaryDomains: [],
        config: "{}",
        disclaimer: "   ",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(
      error instanceof Response
        ? error.status
        : (error as { status?: number })?.status,
    ).toBe(400);
  });

  it("rejects invalid JSON or empty analysis config", async () => {
    const indRes = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('tech-cfg', 'Tech', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const indId = indRes!.id;

    // Bad JSON
    let err1: unknown = null;
    try {
      await updateIndustryConfig(env.DB, {
        id: indId,
        publishMode: "review",
        primaryDomains: [],
        config: "not json",
        disclaimer: null,
      });
    } catch (e) {
      err1 = e;
    }
    expect(err1 instanceof Response ? err1.status : 0).toBe(400);

    // Empty analysis object
    let err2: unknown = null;
    try {
      await updateIndustryConfig(env.DB, {
        id: indId,
        publishMode: "review",
        primaryDomains: [],
        config: JSON.stringify({ analysis: {} }),
        disclaimer: null,
      });
    } catch (e) {
      err2 = e;
    }
    expect(err2 instanceof Response ? err2.status : 0).toBe(400);
  });
});
