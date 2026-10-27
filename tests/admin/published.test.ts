import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listPublishedArticles } from "../../src/server/admin/ops";

// #87 A3b: the admin "Published" list. Only approved articles (the one
// definition in src/server/publication/articles.ts), newest first, 100 rows.
describe("listPublishedArticles", () => {
  it("returns only approved articles, newest first, at most 100", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('published-list', 'Published', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Src', 'https://published.example/feed', 'rss', 'active', 0) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const insertArticle = (n: number, sha: string) =>
      env.DB.prepare(
        `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, published_at, fetched_at)
         VALUES (?1, ?2, ?3, ?3, ?4, 'grouped', 0, ?5, ?6, 0)
         RETURNING id`,
      )
        .bind(
          src!.id,
          ind!.id,
          `https://published.example/${n}`,
          `Article ${n}`,
          sha,
          1_000_000 + n,
        )
        .first<{ id: number }>();
    const review = (articleId: number, sha: string, decision: string) =>
      env.DB.prepare(
        "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, ?2, ?3, 'admin@example.com', 0)",
      )
        .bind(articleId, sha, decision)
        .run();

    // 101 approved articles; article n is published at 1_000_000 + n.
    const approved: number[] = [];
    for (let n = 1; n <= 101; n++) {
      const row = await insertArticle(n, `sha-${n}`);
      await review(row!.id, `sha-${n}`, "approved");
      approved.push(row!.id);
    }
    // Newer than all of them, but not approved.
    const rejected = await insertArticle(200, "sha-200");
    await review(rejected!.id, "sha-200", "rejected");
    const pending = await insertArticle(201, "sha-201");
    // Approved for an older body only.
    const stale = await insertArticle(202, "sha-202-new");
    await review(stale!.id, "sha-202-old", "approved");

    const rows = await listPublishedArticles(env.DB);

    expect(rows).toHaveLength(100);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(rejected!.id);
    expect(ids).not.toContain(pending!.id);
    expect(ids).not.toContain(stale!.id);
    // Newest first; the oldest of the 101 falls off.
    expect(ids).toEqual(approved.slice(1).reverse());
    expect(rows[0]).toMatchObject({
      id: approved[100],
      title: "Article 101",
      industryName: "Published",
      bodySha: "sha-101",
      publishedAt: 1_000_101,
    });
  });
});
