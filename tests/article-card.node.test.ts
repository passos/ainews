import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleCard } from "../src/components/ArticleCard";
import type { ArticleView } from "../src/server/publication/articles";

const article: ArticleView = {
  id: 1,
  title: "A title",
  summary: null,
  url: "https://news.example/a",
  sourceName: "Wire",
  publishedAt: null,
  fetchedAt: 1_000,
  evidence: [],
  correction: null,
  sectionSlug: "technology",
  sectionName: "Technology",
  sectionDisclaimer: null,
};

describe("ArticleCard link", () => {
  it("links an http(s) url with rel noopener noreferrer", () => {
    const html = renderToStaticMarkup(ArticleCard({ article }));
    expect(html).toContain('href="https://news.example/a"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders no link when the url is null", () => {
    const html = renderToStaticMarkup(
      ArticleCard({ article: { ...article, url: null } }),
    );
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<a ");
    expect(html).toContain("A title");
  });
});
