// #87 slice A3d: the public watch page never shows "Revision #N" (internal
// vocabulary: the story state after the Nth approved report joined). A hit
// header shows only the hit time.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { WatchView } from "../../src/routes/w/$watch";
import type { WatchDetailView } from "../../src/server/publication/watches";
import { renderInRouter } from "../helpers/render-in-router";

const HIT_AT = Date.UTC(2026, 9, 26, 15, 4, 0);

const data: WatchDetailView = {
  watch: {
    id: 1,
    slug: "ai-startups",
    question: "Which AI startups reach a public listing?",
    criteria: "A filing or an official announcement.",
    keywords: ["ipo"],
    status: "active",
    industryId: 1,
    industryName: "Technology",
    industrySlug: "technology",
    industryDisclaimer: null,
    createdAt: HIT_AT,
  },
  hits: [
    {
      id: 11,
      eventId: 177,
      eventTitle: "A company files for its public debut",
      eventRevision: 3,
      hitAt: HIT_AT,
      summary: "The company filed publicly.",
      rationale: "Official filing.",
      articles: [],
    },
    {
      id: 12,
      eventId: 178,
      eventTitle: "Another company",
      eventRevision: 7,
      hitAt: HIT_AT - 86_400_000,
      summary: "A second development.",
      rationale: "Announcement.",
      articles: [],
    },
  ],
};

describe("watch page hit header", () => {
  it("does not show Revision, in any case", async () => {
    const html = await renderInRouter(createElement(WatchView, { data }));
    expect(html).not.toContain("Revision");
    expect(html).not.toMatch(/revision/i);
  });

  it("still shows each hit time", async () => {
    const html = await renderInRouter(createElement(WatchView, { data }));
    expect(html).toContain("Oct 26, 2026");
    expect(html).toContain("Oct 25, 2026");
  });
});
