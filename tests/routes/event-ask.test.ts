import { env } from "cloudflare:workers";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { isEnabled } from "../../src/lib/flags";
import { EventPageView } from "../../src/routes/e/$eventId";
import type { SectionInfo } from "../../src/server/publication/articles";
import type { EventView } from "../../src/server/publication/events";
import { loadSiteShell } from "../../src/server/publication/shell";
import { renderInRouter } from "../helpers/render-in-router";
import { resetPublication, seedSections } from "../publication/helpers";

const TECH: SectionInfo = {
  slug: "technology",
  name: "Technology",
  disclaimer: null,
};
const FINANCE: SectionInfo = {
  slug: "finance",
  name: "Finance",
  disclaimer: "Not investment advice.",
};

function eventView(section: SectionInfo): EventView {
  return {
    id: 7,
    title: "An event",
    section,
    articles: [],
    timelineRevisions: [],
    corrections: [],
    artifacts: null,
    evidence: { claims: [] },
  } as unknown as EventView;
}

const ASK = {
  onAsk: async () => ({ questionId: 1, token: "t" }),
  onPoll: async () => ({}),
};

const render = (section: SectionInfo, ask: typeof ASK | null) =>
  renderInRouter(
    createElement(EventPageView, {
      data: eventView(section),
      artifactSources: [],
      sources: Promise.resolve([]),
      ask,
    }),
  );

describe("Ask about this story card", () => {
  beforeEach(async () => {
    await resetPublication();
    await seedSections();
  });

  it("loadSiteShell reports the switch, off under env.test", async () => {
    expect(isEnabled(env, "ASK_PUBLIC_ENABLED")).toBe(false);
    const shell = await loadSiteShell();
    expect(shell.askPublicEnabled).toBe(false);
  });

  it("is absent when the switch is off", async () => {
    const html = await render(TECH, null);
    expect(html).not.toContain("Ask about this story");
    expect(html).not.toContain("<textarea");
  });

  it("shows a POST form when the switch is on", async () => {
    const html = await render(TECH, ASK);
    expect(html).toContain("Ask about this story");
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html).toContain("<textarea");
    expect(html).toContain(">Ask</button>");
  });

  it("is absent on a Finance story even when the switch is on", async () => {
    const html = await render(FINANCE, ASK);
    expect(html).not.toContain("Ask about this story");
  });
});
