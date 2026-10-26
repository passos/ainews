import { env } from "cloudflare:workers";
import { isNotFound } from "@tanstack/react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { loadArticle } from "../../src/routes/a/$articleId";
import { getArticlePage } from "../../src/server/publication/articles";
import {
  db,
  resetPublication,
  seedArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

let tech: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
});

const fns = {
  getArticle: (articleId: number) =>
    getArticlePage(db(), env.BODIES, articleId),
};

async function notFound(articleId: string): Promise<boolean> {
  try {
    await loadArticle({ articleId }, fns);
    return false;
  } catch (e) {
    return isNotFound(e);
  }
}

describe("loadArticle", () => {
  for (const bad of ["abc", "0", "-1", "1.5", "01", ""]) {
    it(`404 for ${JSON.stringify(bad)}`, async () => {
      expect(await notFound(bad)).toBe(true);
    });
  }

  it("404 for an article that is not approved", async () => {
    const id = await seedArticle({ ...tech, title: "Pending" });
    expect(await notFound(String(id))).toBe(true);
  });

  it("returns the page of an approved article", async () => {
    const id = await seedArticle({ ...tech, title: "Approved" });
    await seedReview(id, "approved");
    const { page } = await loadArticle({ articleId: String(id) }, fns);
    expect(page.article.id).toBe(id);
  });
});
