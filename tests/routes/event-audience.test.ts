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

function explain(audience: "student" | "educator", overview: string) {
  return {
    audience,
    overview,
    keyPoints: ["k"],
    implications: ["i"],
    glossary: [],
  };
}

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
            student: explain("student", "STUDENT-OVERVIEW"),
            educator: explain("educator", "EDUCATOR-OVERVIEW"),
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

describe("Explain for control", () => {
  it("event page: the explanation card carries the labelled tier control", async () => {
    const html = await renderEvent(true);
    expect(html).toContain('<nav aria-label="Explain for"');
    const label = html.indexOf(">Explain for<");
    expect(label).toBeGreaterThanOrEqual(0);
    // The visible label comes before the tier buttons, inside the card.
    expect(label).toBeGreaterThan(
      html.indexOf('aria-label="Audience Explanations"'),
    );
    expect(label).toBeLessThan(html.indexOf(">student</button>"));
    expect(html).not.toContain("Audience tiers");
  });

  it("event page: only one Explain for control (no page-level selector)", async () => {
    const html = await renderEvent(true);
    expect(html.match(/Explain for/g)?.length).toBe(2); // label + nav aria-label
    expect(html).not.toContain('id="audience-label"');
    expect(html).not.toContain("/?audience=professional");
  });

  it("event page: no explanations means no Explain for control", async () => {
    const html = await renderEvent(false);
    expect(html).not.toContain("Explain for");
  });

  it("event page: ?audience=educator opens on the Educator explanation", async () => {
    const html = await renderEvent(true, "educator");
    expect(html).toContain("EDUCATOR-OVERVIEW");
    expect(html).not.toContain("STUDENT-OVERVIEW");
    const none = await renderEvent(true);
    expect(none).toContain("STUDENT-OVERVIEW");
    expect(none).not.toContain("EDUCATOR-OVERVIEW");
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
