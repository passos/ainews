import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleReader } from "../src/components/ArticleReader";
import type {
  ArticlePage,
  ArticleView,
} from "../src/server/publication/articles";

const article: ArticleView = {
  id: 1,
  title: "A title",
  summary: "The summary.",
  url: "https://news.example/a",
  sourceName: "Wire",
  publishedAt: 1_000,
  fetchedAt: 2_000,
  evidence: [],
  correction: null,
  sectionSlug: "technology",
  sectionName: "Technology",
  sectionDisclaimer: null,
  eventId: null,
  eventReportCount: 0,
  inputRevision: 1,
};

const base: ArticlePage = {
  article,
  summaryKind: "ai",
  editorApproved: true,
  bodyHtml: "<p>BODY</p>",
  excerpted: false,
  bodyIsAbstract: false,
};

const render = (page: Partial<ArticlePage>, a: Partial<ArticleView> = {}) =>
  renderToStaticMarkup(
    createElement(ArticleReader, {
      page: { ...base, ...page, article: { ...article, ...a } },
    }),
  );

describe("ArticleReader", () => {
  it("orders title, original link, AI summary, body, bottom original link", () => {
    const html = render({});
    const steps = [
      html.indexOf("A title"),
      html.indexOf("Read the original at Wire ↗"),
      html.indexOf("AI summary"),
      html.indexOf("article-body"),
      html.lastIndexOf("Read the original at Wire ↗"),
    ];
    expect(steps.every((n) => n >= 0)).toBe(true);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);
    expect(steps[4]).toBeGreaterThan(steps[1]);
    expect(html).toContain('href="https://news.example/a"');
    expect(html).toContain("<p>BODY</p>");
  });

  it("shows the disclaimer only when the section has one", () => {
    const withIt = render({}, { sectionDisclaimer: "Not investment advice." });
    expect(withIt).toContain('role="note"');
    expect(withIt).toContain("Not investment advice.");
    expect(render({})).not.toContain('role="note"');
  });

  it("adds Continue reading only in excerpt mode", () => {
    expect(render({ excerpted: true })).toContain(
      "Continue reading the original ↗",
    );
    expect(render({ excerpted: false })).not.toContain("Continue reading");
  });

  it("without a body shows the summary only", () => {
    const html = render({ bodyHtml: null });
    expect(html).not.toContain("article-body");
    expect(html).toContain("The summary.");
  });

  it("without a url has no original links", () => {
    const html = render({ excerpted: true }, { url: null });
    expect(html).not.toContain("Read the original");
    expect(html).not.toContain("Continue reading");
  });

  it("labels the summary by its author", () => {
    expect(render({ summaryKind: "ai", editorApproved: true })).toContain(
      "AI summary · editor-approved",
    );
    const auto = render({ summaryKind: "ai", editorApproved: false });
    expect(auto).toContain("AI summary");
    expect(auto).not.toContain("editor-approved");
    const editor = render({ summaryKind: "editor" });
    expect(editor).toContain("Editor&#x27;s summary");
    expect(editor).not.toContain("AI summary");
    const feed = render({ summaryKind: "feed" });
    expect(feed).toContain("Summary from Wire");
    expect(feed).not.toContain("AI summary");
  });

  it("marks an abstract body as the authors' text", () => {
    const html = render({ bodyIsAbstract: true });
    expect(html).toContain("Abstract");
    expect(html).toContain("by the authors");
    expect(render({})).not.toContain("Abstract");
  });

  it("has no Chinese text", () => {
    const html = render(
      { excerpted: true, summaryKind: "feed" },
      { sectionDisclaimer: "D.", correction: "C." },
    );
    expect(/[一-鿿]/.test(html)).toBe(false);
  });

  it("shows a correction", () => {
    expect(render({}, { correction: "Fixed a number." })).toContain(
      "Correction",
    );
  });

  it("links the story page when the article belongs to an event", () => {
    const html = render({}, { eventId: 42 });
    expect(html).toContain('href="/e/42"');
    expect(html).toContain("Story brief, explanations and evidence →");
    expect(html).not.toContain("This story on Daily");
    // Near the top: after the meta line, before the original link, the
    // summary and the body.
    const link = html.indexOf('href="/e/42"');
    expect(link).toBeGreaterThan(html.indexOf("Fetched"));
    expect(link).toBeLessThan(html.indexOf("Read the original at Wire ↗"));
    expect(link).toBeLessThan(html.indexOf("AI summary"));
    expect(link).toBeLessThan(html.indexOf("article-body"));
  });

  it("the story link is one clickable block with a label and a heading link", () => {
    const html = render({}, { eventId: 42 });
    const m = /<a [^>]*href="\/e\/42"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(m).not.toBeNull();
    const [open, inner] = [m![0], m![1]];
    // The anchor wraps the block: label and link text are both inside it.
    expect(inner).toContain("On Daily");
    expect(inner).toContain("Story brief, explanations and evidence →");
    expect(open).toMatch(/class="[^"]*\bborder-y\b/);
    expect(open).toMatch(/class="[^"]*\bpy-3\b/);
    expect(inner).toMatch(
      /class="[^"]*\btext-xs\b[^"]*\btext-muted-foreground\b[^"]*">On Daily/,
    );
    expect(inner).toMatch(
      /class="[^"]*\bfont-heading\b[^"]*\btext-lg\b[^"]*\bfont-semibold\b[^"]*">Story brief/,
    );
    // Quiet: no fill, no shadow.
    expect(open).not.toMatch(/\b(bg-|shadow)/);
  });

  it("uses one centred reading column for the whole article", () => {
    const html = render({ bodyIsAbstract: true }, { eventId: 42 });
    const article = /<article\b[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(article).toMatch(/\bmx-auto\b/);
    expect(article).toMatch(/\bw-full\b/);
    expect(article).toContain("max-w-[40rem]");
    // No inner width caps: every part uses the column width.
    expect(html).not.toContain("max-w-[20em]");
    expect(html).not.toContain("max-w-[36em]");
    const h1 = /<h1\b[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(h1).toMatch(/\btext-3xl\b/);
    expect(h1).toContain("sm:text-[2.75rem]");
    expect(h1).not.toContain("sm:text-5xl");
  });

  it(".article-body has no max-width of its own", () => {
    const css = readFileSync(
      join(import.meta.dirname, "../src/styles.css"),
      "utf8",
    );
    const rule = /\.article-body\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/max-width:\s*none/);
  });

  it("shows no story link without an event", () => {
    const html = render({}, { eventId: null });
    expect(html).not.toContain('href="/e/');
    expect(html).not.toContain("This story on Daily");
  });
});
