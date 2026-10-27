// #87 slice A2: the /s/$section header is a plain title row with a thin rule
// under it, not a heavy rule above.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { SectionHeader } from "../../src/routes/s/$section";
import { renderInRouter } from "../helpers/render-in-router";

const section = {
  slug: "technology",
  name: "Technology",
  disclaimer: null,
  latestDigestDate: "2026-10-26",
  latestWeeklyDigestDate: null,
};

describe("section header", () => {
  it("has no heavy top rule and a thin rule below the row", async () => {
    const html = await renderInRouter(
      createElement(SectionHeader, { section }),
    );
    const row = /<div class="([^"]*)"><h1/.exec(html)?.[1] ?? "";
    expect(row).toMatch(/\bborder-b\b/);
    expect(row).toMatch(/\bpb-2\b/);
    expect(row).not.toContain("border-t-[3px]");
    expect(row).not.toContain("border-foreground");
    expect(row).not.toMatch(/\bpt-1\b/);
  });

  it("keeps the title size and the header links", async () => {
    const html = await renderInRouter(
      createElement(SectionHeader, { section }),
    );
    expect(html).toMatch(/<h1 class="[^"]*\btext-4xl\b[^"]*\bsm:text-5xl\b/);
    expect(html).toContain("Technology");
    expect(html).toContain("Daily Digest");
    expect(html).toContain("/rss/technology.xml");
  });
});
