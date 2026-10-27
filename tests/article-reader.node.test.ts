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
  event: null,
};

const asideOf = (html: string) =>
  /<aside\b[^>]*aria-label="About this story"[\s\S]*?<\/aside>/.exec(
    html,
  )?.[0] ?? "";

const render = (page: Partial<ArticlePage>, a: Partial<ArticleView> = {}) =>
  renderToStaticMarkup(
    createElement(ArticleReader, {
      page: { ...base, ...page, article: { ...article, ...a } },
    }),
  );

describe("ArticleReader", () => {
  it("orders kicker, title, summary and body; the original link is in the sidebar once", () => {
    const html = render({});
    const steps = [
      html.indexOf('href="/s/technology"'),
      html.indexOf("A title"),
      html.indexOf("AI summary"),
      html.indexOf("article-body"),
    ];
    expect(steps.every((n) => n >= 0)).toBe(true);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);
    expect(html.split("Read the original at Wire ↗").length - 1).toBe(1);
    const aside = asideOf(html);
    expect(aside).toContain('href="https://news.example/a"');
    expect(aside).toContain("Read the original at Wire ↗");
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

  it("links the story page from the sidebar when the article belongs to an event", () => {
    const html = render({}, { eventId: 42 });
    const aside = asideOf(html);
    expect(aside).toContain('href="/e/42"');
    expect(aside).toContain("Story brief, explanations and evidence →");
    expect(html).not.toContain("This story on Daily");
    // The only story link on the page.
    expect(html.split('href="/e/42"').length - 1).toBe(1);
  });

  it("sidebar block 1 is On Daily: 3px top rule, label, large serif link", () => {
    const aside = asideOf(render({}, { eventId: 42 }));
    const block =
      /<div [^>]*class="([^"]*)"[^>]*>(?:(?!<\/div>)[\s\S])*On Daily/.exec(
        aside,
      );
    expect(block).not.toBeNull();
    expect(block![1]).toContain("border-t-[3px]");
    expect(block![1]).toContain("border-foreground");
    expect(aside).toMatch(
      /class="[^"]*\btext-xs\b[^"]*\btext-muted-foreground\b[^"]*">On Daily/,
    );
    const link = /<a [^>]*href="\/e\/42"[^>]*class="([^"]*)"/.exec(aside)?.[1];
    expect(link).toMatch(/\bfont-heading\b/);
    expect(link).toMatch(/\btext-\[1\.375rem\]/);
    expect(link).toMatch(/\bfont-semibold\b/);
    expect(aside).not.toMatch(/\b(bg-|shadow)/);
  });

  it("sidebar block 2 is Source: hairline top rule, From / Published / Fetched in a dl", () => {
    const aside = asideOf(render({}));
    const block =
      /<div [^>]*class="([^"]*)"[^>]*>(?:(?!<\/div>)[\s\S])*Source</.exec(
        aside,
      );
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/\bborder-t\b/);
    expect(block![1]).not.toContain("border-t-[3px]");
    const dl = /<dl\b[\s\S]*?<\/dl>/.exec(aside)?.[0] ?? "";
    expect(dl).toMatch(/<dt[^>]*>From<\/dt>\s*<dd[^>]*>Wire<\/dd>/);
    expect(dl).toMatch(/<dt[^>]*>Published<\/dt>\s*<dd[^>]*><time /);
    expect(dl).toMatch(/<dt[^>]*>Fetched<\/dt>\s*<dd[^>]*><time /);
    // Source is the second block, after On Daily.
    const withEvent = asideOf(render({}, { eventId: 42 }));
    expect(withEvent.indexOf("On Daily")).toBeLessThan(
      withEvent.indexOf("Source<"),
    );
  });

  it("omits Published when the source gave no date", () => {
    const dl = /<dl\b[\s\S]*?<\/dl>/.exec(
      render({}, { publishedAt: null }),
    )?.[0];
    expect(dl).toContain("Fetched");
    expect(dl).not.toContain("Published");
  });

  it("shows no original link without a url", () => {
    expect(asideOf(render({}, { url: null }))).not.toContain(
      "Read the original",
    );
  });

  it("an article without an event has only the Source block", () => {
    const aside = asideOf(render({}, { eventId: null }));
    expect(aside).toContain("Source");
    expect(aside).not.toContain("On Daily");
    expect(aside).not.toContain('href="/e/');
  });

  it("title block: kicker links the section, title spans the page, one hairline", () => {
    const html = render({}, { eventId: 42 });
    const header = /<header\b[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    expect(header).toMatch(
      /<a [^>]*href="\/s\/technology"[^>]*>Technology<\/a>/,
    );
    expect(header).toContain("<h1");
    expect(header).toMatch(/^<header [^>]*class="[^"]*\bborder-b\b/);
    // Nothing under the meta line any more: no other horizontal rule.
    const rest = html.replace(header, "");
    const rules = rest.match(/class="[^"]*\bborder-(?:b|y)\b[^"]*"/g) ?? [];
    expect(rules).toEqual([]);
  });

  it("is full width: no centred column, two-column grid at 860px, sidebar sticky", () => {
    const html = render({ bodyIsAbstract: true }, { eventId: 42 });
    const article = /<article\b[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(article).not.toMatch(/\bmx-auto\b/);
    expect(article).not.toContain("max-w-[40rem]");
    expect(html).not.toContain("max-w-[40rem]");
    expect(html).not.toContain("max-w-[20em]");
    expect(html).not.toContain("max-w-[36em]");
    const grid = /<div [^>]*class="([^"]*grid[^"]*)"/.exec(html)?.[1] ?? "";
    expect(grid).toContain(
      "min-[860px]:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]",
    );
    const aside =
      /<aside\b[^>]*aria-label="About this story"[^>]*class="([^"]*)"/.exec(
        html,
      )?.[1] ?? "";
    // Stacked above the body below 860px, sticky from 860px.
    expect(aside).toMatch(/(^| )order-first( |$)/);
    expect(aside).toContain("min-[860px]:order-none");
    expect(aside).toContain("min-[860px]:sticky");
    expect(aside).not.toMatch(/(^| )sticky( |$)/);
    const h1 = /<h1\b[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(h1).toMatch(/\btext-3xl\b/);
    expect(h1).toContain("sm:text-[2.75rem]");
    expect(h1).not.toContain("sm:text-5xl");
    expect(h1).not.toMatch(/max-w-/);
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

  it("keeps the disclaimer and correction in the body column, not the sidebar", () => {
    const html = render(
      {},
      { sectionDisclaimer: "Not advice.", correction: "Fixed." },
    );
    const aside = asideOf(html);
    expect(aside).not.toContain("Not advice.");
    expect(aside).not.toContain("Fixed.");
    expect(html).toContain("Not advice.");
    expect(html).toContain("Fixed.");
  });

  describe("On Daily block data", () => {
    const event = {
      whatHappened: "An audit found flaws.",
      sections: { brief: true, evidenceClaims: 4, explain: true, ask: true },
    };
    const links = (aside: string) =>
      [
        ...aside.matchAll(/<a [^>]*href="(\/e\/42#[^"]+)"[^>]*>([^<]*)<\/a>/g),
      ].map((m) => [m[1], m[2]]);

    it("shows the What happened sentence and the anchor links", () => {
      const aside = asideOf(render({ event }, { eventId: 42 }));
      expect(aside).toContain("An audit found flaws.");
      expect(links(aside)).toEqual([
        ["/e/42#brief", "Brief"],
        ["/e/42#evidence", "Evidence · 4 claims"],
        ["/e/42#explain", "Explain"],
        ["/e/42#ask", "Ask"],
      ]);
      // Between the story link and the Source block.
      expect(aside.indexOf("An audit found flaws.")).toBeGreaterThan(
        aside.indexOf("Story brief, explanations and evidence →"),
      );
      expect(aside.indexOf("An audit found flaws.")).toBeLessThan(
        aside.indexOf("Source<"),
      );
    });

    it("omits the sentence when there is none", () => {
      const aside = asideOf(
        render({ event: { ...event, whatHappened: null } }, { eventId: 42 }),
      );
      expect(aside).not.toContain("An audit found flaws.");
      // No empty paragraph left behind.
      expect(aside).not.toContain("text-[0.9375rem]");
      expect(links(aside).length).toBe(4);
    });

    it("lists only the sections that exist", () => {
      const aside = asideOf(
        render(
          {
            event: {
              whatHappened: null,
              sections: {
                brief: false,
                evidenceClaims: 1,
                explain: false,
                ask: false,
              },
            },
          },
          { eventId: 42 },
        ),
      );
      expect(links(aside)).toEqual([["/e/42#evidence", "Evidence · 1 claim"]]);
      const none = asideOf(
        render(
          {
            event: {
              whatHappened: null,
              sections: {
                brief: false,
                evidenceClaims: 0,
                explain: false,
                ask: false,
              },
            },
          },
          { eventId: 42 },
        ),
      );
      expect(links(none)).toEqual([]);
      expect(none).toContain("Story brief, explanations and evidence →");
    });
  });
});
