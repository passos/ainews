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
  eventId: null,
  eventReportCount: 0,
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

  it("renders story link when eventReportCount >= 2 and eventId is present", () => {
    const html = renderToStaticMarkup(
      ArticleCard({
        article: { ...article, eventId: 42, eventReportCount: 3 },
      }),
    );
    expect(html).toContain("View story · 3 reports");
    expect(html).toContain('href="/e/42"');
  });

  it("does not render story link when eventReportCount < 2", () => {
    const html = renderToStaticMarkup(
      ArticleCard({
        article: { ...article, eventId: 42, eventReportCount: 1 },
      }),
    );
    expect(html).not.toContain("View story");
  });
});
