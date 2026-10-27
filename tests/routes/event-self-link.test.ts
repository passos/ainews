// #87 slice A3e: article cards rendered inside /e/$id must not link back to
// the event page they are on. "Read the original" stays.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ArticleCard } from "../../src/components/ArticleCard";
import { EventPageView } from "../../src/routes/e/$eventId";
import type {
  ArticleView,
  SectionInfo,
} from "../../src/server/publication/articles";
import type { EventView } from "../../src/server/publication/events";
import { renderInRouter } from "../helpers/render-in-router";

const section: SectionInfo = {
  slug: "technology",
  name: "Technology",
  disclaimer: null,
};

const art = (id: number, eventId: number | null = 7): ArticleView => ({
  id,
  title: `Article ${id}`,
  summary: null,
  url: `https://example.com/${id}`,
  sourceName: "Src",
  publishedAt: Date.parse("2026-10-24T08:00:00Z"),
  fetchedAt: 1_000,
  evidence: [],
  correction: null,
  sectionSlug: "technology",
  sectionName: "Technology",
  sectionDisclaimer: null,
  eventId,
  eventReportCount: 3,
  inputRevision: 1,
});

const view = (articles: ArticleView[], timelineRevisions: unknown): EventView =>
  ({
    id: 7,
    title: "An event",
    section,
    articles,
    timelineRevisions,
    corrections: [],
    artifacts: null,
    evidence: { claims: [] },
  }) as unknown as EventView;

const render = (data: EventView) =>
  renderInRouter(
    createElement(EventPageView, {
      data,
      artifactSources: [],
      sources: Promise.resolve([]),
      ask: null,
    }),
  );

const BLOCKS = [
  {
    revision: 1,
    diff: { summary: "First.", changedClaims: [] },
    articles: [art(1), art(2)],
  },
  {
    revision: 2,
    diff: { summary: "Second.", changedClaims: [] },
    articles: [art(3)],
  },
];

describe("event page timeline cards", () => {
  it("has no View story / Story brief link to itself (revision blocks)", async () => {
    const html = await render(view([], BLOCKS));
    expect(html).not.toContain("View story");
    expect(html).not.toContain("Story brief &amp; explainers");
    expect(html).not.toContain('href="/e/7"');
  });

  it("has no link to itself in the fallback list either", async () => {
    const html = await render(view([art(1), art(2)], null));
    expect(html).toContain("Article 1");
    expect(html).not.toContain("View story");
    expect(html).not.toContain('href="/e/7"');
  });

  it("keeps Read the original on every card", async () => {
    const html = await render(view([], BLOCKS));
    expect(html.match(/Read the original at Src/g)).toHaveLength(3);
  });
});

describe("ArticleCard hideEventLink", () => {
  it("shows the story link by default and hides it on request", async () => {
    const shown = await renderInRouter(
      createElement(ArticleCard, { article: art(1, 9) }),
    );
    expect(shown).toContain('href="/e/9"');
    expect(shown).toContain("View story · 3 reports →");

    const hidden = await renderInRouter(
      createElement(ArticleCard, { article: art(1, 9), hideEventLink: true }),
    );
    expect(hidden).not.toContain('href="/e/9"');
    expect(hidden).toContain("Read the original at Src");
  });
});
