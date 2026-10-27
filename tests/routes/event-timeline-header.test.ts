// #87 slice A3d: the Timeline never shows "Revision N". Each block reads
// "First report" or "New report" plus the date of its first article.
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

const art = (
  id: number,
  publishedAt: number | null,
  fetchedAt: number,
  title = `Article ${id}`,
) => ({
  id,
  title,
  summary: null,
  url: "https://example.com/x",
  sourceName: "Src",
  publishedAt,
  fetchedAt,
  evidence: [],
  correction: null,
  sectionSlug: "technology",
  sectionName: "Technology",
  sectionDisclaimer: null,
  eventId: 7,
  eventReportCount: 3,
  inputRevision: 1,
});

// Block 1 and 2 have a published date. Block 3 has none, so it falls back to
// fetched_at. Block 1's second article has a later date: only the first counts.
const P1 = Date.parse("2026-10-24T08:00:00Z");
const P2 = Date.parse("2026-10-25T23:30:00Z");
const F3 = Date.parse("2026-10-26T23:30:00Z");

const BLOCKS = [
  {
    revision: 1,
    diff: { summary: "Initial.", changedClaims: [] },
    articles: [
      art(1, P1, 5_000),
      art(2, Date.parse("2026-11-30T00:00:00Z"), 1),
    ],
  },
  {
    revision: 2,
    diff: { summary: "Second.", changedClaims: ["Claim A (x → y)"] },
    articles: [art(3, P2, 6_000)],
  },
  {
    revision: 3,
    diff: { summary: "Third.", changedClaims: [] },
    articles: [art(4, null, F3)],
  },
];

const view = (timelineRevisions: unknown = BLOCKS) =>
  ({
    id: 7,
    title: "An event",
    section,
    articles: [],
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

function timelineOf(html: string): string {
  const m = /<section\b[^>]*id="timeline"[\s\S]*?<\/section>/.exec(html);
  return m?.[0] ?? "";
}

function headers(html: string) {
  return [
    ...timelineOf(html).matchAll(
      /<span[^>]*>(First report|New report)<\/span><time[^>]*datetime="([^"]+)"[^>]*>([^<]*)<\/time>/gi,
    ),
  ].map((m) => ({ label: m[1], iso: m[2], text: m[3] }));
}

describe("Timeline block headers", () => {
  it("never shows the word Revision on the page", async () => {
    const html = await render(view());
    expect(timelineOf(html)).not.toBe("");
    expect(html).not.toContain("Revision");
    expect(html).not.toContain("First seen");
  });

  it("reads First report, then New report for every later block", async () => {
    const html = await render(view());
    expect(headers(html).map((h) => h.label)).toEqual([
      "First report",
      "New report",
      "New report",
    ]);
  });

  it("shows the date of the block's FIRST article, falling back to fetched_at", async () => {
    const html = await render(view());
    expect(headers(html).map((h) => h.text)).toEqual([
      "Oct 24, 2026",
      "Oct 25, 2026",
      "Oct 26, 2026",
    ]);
    expect(headers(html).map((h) => h.iso)).toEqual([
      new Date(P1).toISOString(),
      new Date(P2).toISOString(),
      new Date(F3).toISOString(),
    ]);
  });

  it("uses the new diff labels and drops the old ones", async () => {
    const html = timelineOf(await render(view()));
    expect(html).toContain("What this report added:");
    expect(html).toContain("Changes to earlier claims:");
    expect(html).not.toContain("What&#x27;s new in this revision");
    expect(html).not.toContain("in this revision");
    expect(html).not.toContain("Status updates on existing claims");
  });

  it("drops the boxed fills; blocks are split by one hairline each", async () => {
    const html = timelineOf(await render(view()));
    expect(html).not.toContain("bg-primary/10");
    expect(html).not.toContain("bg-card/30");
    expect(html).not.toContain("bg-muted/40");
    const blocks = [
      ...html.matchAll(/<div class="([^"]*)" data-timeline-block="(\d+)"/g),
    ];
    expect(blocks).toHaveLength(3);
    expect(blocks[0][1]).not.toMatch(/\bborder/);
    for (const b of blocks.slice(1)) expect(b[1]).toMatch(/\bborder-t\b/);
    for (const b of blocks) expect(b[1]).not.toMatch(/\bborder-b\b/);
  });
});
