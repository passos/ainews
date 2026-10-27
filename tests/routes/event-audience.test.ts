import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { SiteHeader } from "../../src/routes/__root";
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
  eventId: 7,
  eventReportCount: 1,
  inputRevision: 1,
};

function eventView(withExplanations: boolean): EventView {
  return {
    id: 7,
    title: "An event",
    section,
    articles: [article],
    timelineRevisions: [],
    corrections: [],
    artifacts: {
      brief: null,
      explanations: withExplanations
        ? {
            student: {
              audience: "student",
              overview: "STUDENT-OVERVIEW",
              keyPoints: ["k"],
              implications: ["i"],
              glossary: [],
            },
          }
        : {},
      decoder: null,
    },
    evidence: { claims: [] },
  } as unknown as EventView;
}

const renderEvent = (withExplanations: boolean, audience?: "educator") =>
  renderInRouter(
    createElement(EventPageView, {
      data: eventView(withExplanations),
      artifactSources: [
        { id: 1, title: "S", publishedAt: null, fetchedAt: 1_000 },
      ],
      sources: Promise.resolve([]),
      audience,
    }),
    audience ? `/?audience=${audience}` : "/",
  );

describe("Explain for selector placement", () => {
  it("event page: the selector sits directly above the explanations", async () => {
    const html = await renderEvent(true);
    const sel = html.indexOf("Explain for");
    const card = html.indexOf('aria-label="Audience Explanations"');
    expect(sel).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThanOrEqual(0);
    expect(sel).toBeLessThan(card);
    // Nothing else of the page sits between the two.
    expect(html.slice(sel, card)).not.toContain("<h1");
    expect(html).toContain("STUDENT-OVERVIEW");
  });

  it("event page: no explanations means no selector", async () => {
    const html = await renderEvent(false);
    expect(html).not.toContain("Explain for");
  });

  it("event page: the selector marks the current audience", async () => {
    const html = await renderEvent(true, "educator");
    // The router sets aria-current="page" on the active link and overrides
    // the component's own value, so the highlight must key on "page".
    const educator = html.match(/<a [^>]*>Educator<\/a>/)?.[0] ?? "";
    expect(educator).toContain('aria-current="page"');
    expect(educator).toContain("aria-[current=page]:bg-primary");
  });

  it("header: no selector, nav links still carry the audience", async () => {
    const html = await renderInRouter(
      createElement(SiteHeader, {
        name: "Daily",
        sections: [{ slug: "technology", name: "Technology" }],
        hasWatches: false,
        readerWatchEnabled: false,
      }),
      "/?audience=student",
    );
    expect(html).toContain("Technology");
    expect(html).not.toContain("Explain for");
    expect(html).toContain("audience=student");
  });
});
