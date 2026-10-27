// APPROVED_ARTICLE_SQL is the one definition of "approved" (#84). Pipeline code
// interpolates the string into D1 prepare() text; public code uses the drizzle
// fragment approvedArticleWhere built from it.
import { env } from "cloudflare:workers";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APPROVED_ARTICLE_SQL,
  approvedArticleWhere,
} from "../../src/server/publication/articles";
import {
  resetPublication,
  seedArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

let ids: number[];

beforeEach(async () => {
  await resetPublication();
  const { technology: tech } = await seedSections();
  // 0: approved at the current body. 1: no review. 2: rejected.
  // 3: approved, but for an older body version.
  ids = [];
  for (const title of ["Approved", "No review", "Rejected", "Old approval"]) {
    ids.push(await seedArticle({ ...tech, title }));
  }
  await seedReview(ids[0], "approved");
  await seedReview(ids[2], "rejected");
  await seedReview(ids[3], "approved", "sha-old");
});

async function idsWhere(condition: string): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id AS id FROM articles a WHERE ${condition} ORDER BY a.id`,
  ).all<{ id: number }>();
  return results.map((r) => r.id);
}

describe("APPROVED_ARTICLE_SQL", () => {
  it("is a plain string, so template interpolation gives SQL text", () => {
    expect(typeof APPROVED_ARTICLE_SQL).toBe("string");
    expect(`${APPROVED_ARTICLE_SQL}`).not.toContain("[object Object]");
  });

  it("approvedArticleWhere renders to exactly APPROVED_ARTICLE_SQL", () => {
    expect(new SQLiteSyncDialect().sqlToQuery(approvedArticleWhere)).toEqual({
      sql: APPROVED_ARTICLE_SQL,
      params: [],
    });
  });

  it("matches only the article approved at its current body", async () => {
    expect(await idsWhere(APPROVED_ARTICLE_SQL)).toEqual([ids[0]]);
  });

  it("a newer body version drops the approval", async () => {
    await env.DB.prepare(
      "UPDATE articles SET body_sha = 'sha-new' WHERE id = ?1",
    )
      .bind(ids[0])
      .run();
    expect(await idsWhere(APPROVED_ARTICLE_SQL)).toEqual([]);
  });

  it("an article with no body version is never approved", async () => {
    await env.DB.prepare("UPDATE articles SET body_sha = NULL WHERE id = ?1")
      .bind(ids[0])
      .run();
    expect(await idsWhere(APPROVED_ARTICLE_SQL)).toEqual([]);
  });
});
