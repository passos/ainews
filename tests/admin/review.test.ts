import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  decideReview,
  listPendingArticles,
} from "../../src/server/admin/review";
import { updateIndustryConfig } from "../../src/server/admin/industries";
import { getDb } from "../../src/server/db/client";

const db = () => getDb(env.DB);

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
    const pending1 = await listPendingArticles({
      data: { industryId: indId },
    } as any);
    expect(pending1.some((a: any) => a.id === artId)).toBe(true);

    // 3. Submitting mismatched bodySha should throw 409 and not change reviews count
    let error: any = null;
    try {
      await decideReview({
        data: { articleId: artId, bodySha: "sha-WRONG", decision: "approved" },
        context: { admin: { email: "admin@example.com" } },
      } as any);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(
      error?.status || (error instanceof Response ? error.status : 0),
    ).toBe(409);

    const reviewsCount1 = await env.DB.prepare(
      "SELECT count(*) as count FROM reviews WHERE article_id = ?1",
    )
      .bind(artId)
      .first<{ count: number }>();
    expect(reviewsCount1!.count).toBe(0);

    // 4. Approve with matching bodySha = 'sha-A'
    await decideReview({
      data: { articleId: artId, bodySha: "sha-A", decision: "approved" },
      context: { admin: { email: "admin@example.com" } },
    } as any);

    // Article should now NOT be in pending list
    const pending2 = await listPendingArticles({
      data: { industryId: indId },
    } as any);
    expect(pending2.some((a: any) => a.id === artId)).toBe(false);

    // 5. Change article body_sha to 'sha-B'
    await env.DB.prepare("UPDATE articles SET body_sha = 'sha-B' WHERE id = ?1")
      .bind(artId)
      .run();

    // 6. Article should be back in pending list because approval was for sha-A
    const pending3 = await listPendingArticles({
      data: { industryId: indId },
    } as any);
    expect(pending3.some((a: any) => a.id === artId)).toBe(true);
  });

  it("rejects publish_mode = 'auto' for Finance section", async () => {
    const finRes = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('finance', 'Finance', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const finId = finRes!.id;

    let error: any = null;
    try {
      await updateIndustryConfig({
        data: {
          id: finId,
          publishMode: "auto",
          primaryDomains: [],
          config: "{}",
          disclaimer: null,
        },
        context: { admin: { email: "admin@example.com" } },
      } as any);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();

    const finRow = await env.DB.prepare(
      "SELECT publish_mode FROM industries WHERE id = ?1",
    )
      .bind(finId)
      .first<{ publish_mode: string }>();
    expect(finRow!.publish_mode).toBe("review");
  });
});
