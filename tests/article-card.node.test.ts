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
  inputRevision: 1,
};

describe("ArticleCard link", () => {
  it("links the title to the reader page and keeps the original link", () => {
    const html = renderToStaticMarkup(ArticleCard({ article }));
    expect(html).toContain('href="/a/1"');
    expect(html).toContain('href="https://news.example/a"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Read the original at Wire");
  });

  it("still links the reader page when the url is null", () => {
    const html = renderToStaticMarkup(
      ArticleCard({ article: { ...article, url: null } }),
    );
    expect(html).toContain('href="/a/1"');
    expect(html).not.toContain("https://news.example");
    expect(html).not.toContain("Read the original");
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

  it("single-report event: links the story page with the brief text", () => {
    for (const eventReportCount of [1, 0]) {
      const html = renderToStaticMarkup(
        ArticleCard({
          article: { ...article, eventId: 42, eventReportCount },
        }),
      );
      expect(html).toContain('href="/e/42"');
      expect(html).toContain("Story brief &amp; explainers →");
      expect(html).not.toContain("View story");
    }
  });

  it("two or more reports keep the report-count text", () => {
    const html = renderToStaticMarkup(
      ArticleCard({
        article: { ...article, eventId: 42, eventReportCount: 2 },
      }),
    );
    expect(html).toContain("View story · 2 reports →");
    expect(html).not.toContain("Story brief");
  });

  it("no event: no story link at all", () => {
    const html = renderToStaticMarkup(
      ArticleCard({ article: { ...article, eventId: null } }),
    );
    expect(html).not.toContain('href="/e/');
    expect(html).not.toContain("View story");
    expect(html).not.toContain("Story brief");
  });

  it("meta row keeps only source, published and fetched", () => {
    const html = renderToStaticMarkup(
      ArticleCard({
        article: { ...article, publishedAt: 500, summary: "Sum." },
      }),
    );
    const meta = /<p [^>]*>\s*<strong[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";
    expect(meta).toContain("Wire");
    expect(meta).toContain("Published");
    expect(meta).toContain("Fetched");
    expect(meta).not.toContain("<a ");
    expect(meta).not.toContain("Read the original");
  });

  it("entry row: story link first (serif), original link after (grey), same line, after the summary", () => {
    const html = renderToStaticMarkup(
      ArticleCard({
        article: {
          ...article,
          summary: "The summary text.",
          eventId: 42,
          eventReportCount: 3,
        },
      }),
    );
    const row = /<div [^>]*data-entry-row[^>]*>[\s\S]*?<\/div>/.exec(html);
    expect(row).not.toBeNull();
    const inner = row![0];
    const story = inner.indexOf('href="/e/42"');
    const original = inner.indexOf('href="https://news.example/a"');
    expect(story).toBeGreaterThan(-1);
    expect(original).toBeGreaterThan(story);
    expect(inner).toMatch(
      /<a [^>]*href="\/e\/42"[^>]*class="[^"]*\bfont-heading\b/,
    );
    expect(inner).toMatch(
      /<a [^>]*href="https:\/\/news\.example\/a"[^>]*class="[^"]*\btext-muted-foreground\b/,
    );
    expect(inner).toContain("Read the original at Wire ↗");
    expect(row!.index).toBeGreaterThan(html.indexOf("The summary text."));
    // Flex row with wrap: both links share one line when they fit.
    expect(inner).toMatch(/^<div [^>]*class="[^"]*\bflex\b[^"]*\bflex-wrap\b/);
  });

  it("entry row holds the original link alone when there is no event, and nothing without a url", () => {
    const only = renderToStaticMarkup(ArticleCard({ article }));
    const row = /<div [^>]*data-entry-row[^>]*>[\s\S]*?<\/div>/.exec(only);
    expect(row?.[0]).toContain("Read the original at Wire ↗");
    expect(row?.[0]).not.toContain('href="/e/');
    const none = renderToStaticMarkup(
      ArticleCard({ article: { ...article, url: null } }),
    );
    expect(none).not.toContain("data-entry-row");
  });

  it("title, meta, tags, summary and entry row are not width-capped", () => {
    const html = renderToStaticMarkup(
      ArticleCard({
        article: {
          ...article,
          summary: "S.",
          evidence: ["preprint"],
          eventId: 42,
          eventReportCount: 1,
        },
      }),
    );
    expect(html).not.toMatch(/max-w-/);
    expect(html).toMatch(/<p class="[^"]*font-serif[^"]*">S\.<\/p>/);
  });
});
