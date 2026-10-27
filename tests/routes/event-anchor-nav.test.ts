// #87 slice A2: /e/$id stays one page. An "On this page" anchor nav sits under
// the title and lists only the sections this event renders.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { EventPageView } from "../../src/routes/e/$eventId";
import { eventSectionFlags } from "../../src/server/publication/event-sections";
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

const fullView = (over: Record<string, unknown> = {}) =>
  eventView({
    ...over,
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
    expect(nav).toBeLessThan(html.indexOf('aria-label="Story brief"'));
  });

  it("lists every section the event renders, with matching ids", async () => {
    const html = await render(fullView(), { ask: ASK });
    const links = navLinks(html);
    const labels = links.map((l) => l.label);
    for (const want of [
      "Story brief",
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
    expect(labels).not.toContain("Story brief");
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

  it("shows no visible 'On this page' text; only the aria-label names the nav", async () => {
    const nav = navOf(await render(fullView()));
    expect(nav).toContain('aria-label="On this page"');
    const inner = nav.replace(/^<nav\b[^>]*>/, "").replace(/<[^>]*>/g, " ");
    expect(inner).not.toMatch(/On this page/i);
  });

  it("has one hairline under the nav: the first section drops its top rule", async () => {
    const html = await render(fullView(), { ask: ASK });
    const wrappers = [
      ...html.matchAll(/<div id="([^"]+)" class="([^"]*)"><section/g),
    ];
    expect(wrappers.length).toBeGreaterThanOrEqual(5);
    expect(wrappers[0][2]).toContain("[&amp;&gt;*]:border-t-0!");
    for (const w of wrappers.slice(1)) {
      expect(w[2], w[1]).not.toContain("border-t-0");
    }
  });

  it("gives every section one h2 in one style, with a grey note after it", async () => {
    const html = await render(fullView({ corrections: ["Fixed a number."] }), {
      ask: ASK,
    });
    const h2s = [...html.matchAll(/<h2 class="([^"]*)">([^<]*)<\/h2>/g)];
    // One per nav link: every listed section has exactly one.
    expect(h2s.length).toBe(navLinks(html).length);
    expect(new Set(h2s.map((m) => m[1])).size).toBe(1);
    const cls = h2s[0][1];
    for (const want of ["font-heading", "text-[1.75rem]", "font-semibold"]) {
      expect(cls).toContain(want);
    }
    expect(cls).not.toMatch(/uppercase|font-mono|tracking-wid/);
    expect(h2s.map((m) => m[2])).toEqual(
      expect.arrayContaining([
        "Story brief",
        "Ask about this story",
        "Evidence",
        "Explain",
        "Learn",
        "Policy impact",
        "Corrections",
        "Timeline",
      ]),
    );
    // The note follows on the same header line.
    expect(
      (html.match(/<\/h2><p class="[^"]*\btext-muted-foreground\b/g) ?? [])
        .length,
    ).toBe(h2s.length);
  });

  it("uses the new section names and drops the old ones", async () => {
    const html = await render(fullView(), { ask: ASK });
    for (const old of [
      "AI Story Brief",
      "Inspect Evidence",
      "News-to-Learning",
      "ASK ABOUT THIS STORY",
    ]) {
      expect(html).not.toContain(old);
    }
    expect(navLinks(html).map((l) => l.label)).toEqual(
      expect.arrayContaining(["Story brief", "Evidence", "Explain", "Ask"]),
    );
  });

  it("has no star, magnifier or other pictograph and no all-caps class", async () => {
    const html = await render(
      fullView({
        timelineRevisions: [
          {
            revision: 1,
            diff: { summary: "New thing", changedClaims: [] },
            articles: [
              {
                id: 1,
                title: "T",
                summary: null,
                url: "https://a.example/x",
                sourceName: "S",
                publishedAt: null,
                fetchedAt: 1_000,
                evidence: ["preprint"],
                correction: null,
                sectionSlug: "technology",
                sectionName: "Technology",
                sectionDisclaimer: null,
                eventId: 7,
                eventReportCount: 1,
                inputRevision: 1,
              },
            ],
          },
        ],
      }),
      { ask: ASK },
    );
    expect(html).not.toMatch(
      /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u,
    );
    expect(html).not.toMatch(/\buppercase\b/);
    expect(html).toContain("First report");
    expect(html).toContain("Original source");
  });

  it("lists corrections in the nav, before Timeline, when they exist", async () => {
    const html = await render(fullView({ corrections: ["Fixed a number."] }));
    const links = navLinks(html);
    expect(links.at(-2)).toEqual({ id: "corrections", label: "Corrections" });
    expect(links.at(-1)).toEqual({ id: "timeline", label: "Timeline" });
    expect(html.match(/id="corrections"/g)?.length).toBe(1);
    expect(html).toMatch(/id="corrections"[^>]*class="[^"]*scroll-mt-14/);
    expect(html).toContain("Fixed a number.");
    const none = await render(fullView());
    expect(navLinks(none).map((l) => l.id)).not.toContain("corrections");
    expect(none).not.toContain('id="corrections"');
  });

  it("the sidebar flags of /a/$id agree with this nav", async () => {
    const cases: [EventView, typeof SOURCES, typeof ASK | null][] = [
      [fullView(), SOURCES, ASK],
      [fullView(), SOURCES, null],
      [fullView(), [], ASK],
      [eventView(), SOURCES, ASK],
      [
        eventView({
          ...fullView(),
          section: { ...section, slug: "finance", name: "Finance" },
        }),
        SOURCES,
        ASK,
      ],
    ];
    for (const [view, sources, ask] of cases) {
      const ids = navLinks(await render(view, { sources, ask })).map(
        (l) => l.id,
      );
      const f = eventSectionFlags(view, sources.length > 0, ask !== null);
      expect(ids.includes("brief")).toBe(f.brief);
      expect(ids.includes("explain")).toBe(f.explain);
      expect(ids.includes("ask")).toBe(f.ask);
      expect(ids.includes("evidence")).toBe(f.evidenceClaims > 0);
      expect(f.evidenceClaims).toBe(view.evidence?.claims.length ?? 0);
    }
  });
});
