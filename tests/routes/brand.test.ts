import { describe, expect, it } from "vitest";
import { Route as RootRoute } from "../../src/routes/__root";
import { Route as SectionRoute } from "../../src/routes/s/$section";
import { loadSiteShell } from "../../src/server/publication/shell";
import { resetPublication, seedSections } from "../publication/helpers";

// The brand is written out here on purpose: these tests must not follow
// SITE_NAME when it changes.
type Head = (ctx: { loaderData: unknown }) => {
  meta?: Record<string, unknown>[];
};

describe("site name in page heads and the shell", () => {
  it("root <title> is exactly Daily", () => {
    const head = RootRoute.options.head as unknown as Head;
    const meta = head({ loaderData: undefined }).meta ?? [];
    expect(meta.find((m) => "title" in m)).toEqual({ title: "Daily" });
  });

  it("section <title> ends with — Daily, and its fallback is Daily", () => {
    const head = SectionRoute.options.head as unknown as Head;
    const fallback = head({ loaderData: undefined }).meta ?? [];
    expect(fallback.find((m) => "title" in m)).toEqual({ title: "Daily" });
    const loaded = head({
      loaderData: {
        data: { section: { name: "Technology", slug: "technology" } },
      },
    }).meta;
    expect(loaded?.find((m) => "title" in m)).toEqual({
      title: "Technology — Daily",
    });
  });

  it("the masthead name served to every page is Daily", async () => {
    await resetPublication();
    await seedSections();
    expect((await loadSiteShell()).name).toBe("Daily");
  });
});
