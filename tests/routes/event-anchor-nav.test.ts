// #87 slice A2: /e/$id stays one page. An "On this page" anchor nav sits under
// the title and lists only the sections this event renders.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { EventPageView } from "../../src/routes/e/$eventId";
import type { SectionInfo } from "../../src/server/publication/articles";
import type { EventView } from "../../src/server/publication/events";
import { renderInRouter } from "../helpers/render-in-router";

const section: SectionInfo = {
  slug: "technology",
  name: "Technology",
  disclaimer: null,
};

const explain = (audience: "student" | "educator") => ({
  audience,
  overview: `${audience} overview`,
  keyPoints: ["k"],
  implications: ["i"],
  glossary: [],
});

const claim = {
  id: 1,
  claimText: "A claim",
  claimType: "fact",
  consensusStatus: "verified",
  primarySourcePreferred: false,
  realityCheck: null,
  status: "published",
  evidence: [],
};

const SOURCES = [{ id: 1, title: "S", publishedAt: null, fetchedAt: 1_000 }];

function eventView(over: Record<string, unknown> = {}): EventView {
  return {
    id: 7,
    title: "An event",
    section,
    articles: [],
    timelineRevisions: [],
    corrections: [],
    artifacts: null,
    evidence: { claims: [] },
    ...over,
  } as unknown as EventView;
}

const fullView = () =>
  eventView({
    artifacts: {
      brief: {
        whatHappened: "BRIEF-HAPPENED",
        whatIsNew: "n",
        whatEvidenceExists: "e",
        whatToWatchNext: "w",
      },
      explanations: { student: explain("student") },
      learningMaterials: {
        student: {
          audience: "student",
          conceptExplainer: "x",
          glossary: [],
          quiz: [],
          discussionQuestions: [],
          activities: [],
        },
      },
      decoder: null,
      policyImpact: {
        policyName: "P",
        summary: "S",
        affectedAudiences: [],
        timeline: [],
        remainingUncertainties: [],
      },
    },
    evidence: { eventId: 7, claims: [claim] },
  });

const ASK = {
  onAsk: async () => ({}),
  onPoll: async () => ({}),
};

const render = (
  data: EventView,
  opts: { sources?: typeof SOURCES; ask?: typeof ASK | null } = {},
) =>
  renderInRouter(
    createElement(EventPageView, {
      data,
      artifactSources: opts.sources ?? SOURCES,
      sources: Promise.resolve([]),
      ask: opts.ask ?? null,
    }),
  );

function navOf(html: string): string {
  const m = /<nav\b[^>]*aria-label="On this page"[^>]*>[\s\S]*?<\/nav>/.exec(
    html,
  );
  return m?.[0] ?? "";
}

const navLinks = (html: string) =>
  [...navOf(html).matchAll(/<a\b[^>]*href="#([^"]+)"[^>]*>([^<]*)<\/a>/g)].map(
    (m) => ({ id: m[1], label: m[2] }),
  );

describe("On this page anchor nav", () => {
  it("sits right under the title, before the first section", async () => {
    const html = await render(fullView());
    const nav = html.indexOf('aria-label="On this page"');
    expect(nav).toBeGreaterThan(html.indexOf("<h1"));
    expect(nav).toBeLessThan(html.indexOf('aria-label="Story Brief"'));
  });

  it("lists every section the event renders, with matching ids", async () => {
    const html = await render(fullView(), { ask: ASK });
    const links = navLinks(html);
    const labels = links.map((l) => l.label);
    for (const want of [
      "Brief",
      "Explain",
      "Learn",
      "Evidence",
      "Timeline",
      "Ask",
      "Policy impact",
    ]) {
      expect(labels).toContain(want);
    }
    // Every target exists once, with scroll margin for the sticky bar.
    for (const { id } of links) {
      const hits = html.match(new RegExp(`id="${id}"`, "g")) ?? [];
      expect(hits.length, id).toBe(1);
      expect(html, id).toMatch(
        new RegExp(`id="${id}"[^>]*class="[^"]*scroll-mt-14`),
      );
    }
    // Nav order follows page order.
    const positions = links.map((l) => html.indexOf(`id="${l.id}"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("lists only sections that exist: an empty event has Timeline only", async () => {
    const html = await render(eventView(), { sources: [] });
    expect(navLinks(html)).toEqual([{ id: "timeline", label: "Timeline" }]);
    expect(html).not.toContain('id="brief"');
  });

  it("omits a section whose card renders nothing (no artifact sources)", async () => {
    const html = await render(fullView(), { sources: [] });
    const labels = navLinks(html).map((l) => l.label);
    expect(labels).not.toContain("Brief");
    expect(labels).not.toContain("Explain");
    expect(labels).not.toContain("Learn");
    expect(html).not.toContain('id="brief"');
    // Cards that need no sources still show.
    expect(labels).toContain("Evidence");
    expect(labels).toContain("Policy impact");
  });

  it("omits Ask when the switch is off and on a Finance story", async () => {
    expect(
      navLinks(await render(fullView())).map((l) => l.label),
    ).not.toContain("Ask");
    const finance = eventView({
      ...fullView(),
      section: { ...section, slug: "finance", name: "Finance" },
    });
    const html = await render(finance, { ask: ASK });
    expect(navLinks(html).map((l) => l.label)).not.toContain("Ask");
    expect(html).not.toContain('id="ask"');
  });

  it("is sticky from sm up, on the page background, with a thin bottom rule", async () => {
    const nav = navOf(await render(fullView()));
    expect(nav).toMatch(/class="[^"]*\bsm:sticky\b/);
    expect(nav).toMatch(/class="[^"]*\bsm:top-0\b/);
    expect(nav).toMatch(/class="[^"]*\bbg-background\b/);
    expect(nav).toMatch(/class="[^"]*\bborder-b\b/);
    expect(nav).not.toMatch(/\bshadow/);
    // Not sticky on narrow screens: the bare `sticky` class is absent.
    expect(nav).not.toMatch(/class="(?:[^"]* )?sticky\b/);
  });

  it("flattens the top-level boxes: border-t, no fill", async () => {
    const html = await render(fullView(), { ask: ASK });
    const sections = [...html.matchAll(/<section\b[^>]*class="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(sections.length).toBeGreaterThanOrEqual(6);
    for (const cls of sections) {
      expect(cls).toMatch(/\bborder-t\b/);
      expect(cls).toMatch(/\bpt-6\b/);
      expect(cls).not.toMatch(/\bbg-card\b/);
      expect(cls).not.toMatch(/(^| )border( |$)/);
      expect(cls).not.toMatch(/(^| )border-2( |$)/);
    }
  });
});
