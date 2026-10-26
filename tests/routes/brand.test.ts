import { describe, expect, it } from "vitest";
import { Route as RootRoute } from "../../src/routes/__root";
import { Route as DigestRoute } from "../../src/routes/digest/$section/$date";
import { Route as EventRoute } from "../../src/routes/e/$eventId";
import { Route as SectionRoute } from "../../src/routes/s/$section";
import { Route as WatchRoute } from "../../src/routes/w/$watch";
import { loadSiteShell } from "../../src/server/publication/shell";
import { resetPublication, seedSections } from "../publication/helpers";

// The brand is written out here on purpose: these tests must not follow
// SITE_NAME when it changes.
type Head = (ctx: { loaderData: unknown }) => {
  meta?: Record<string, unknown>[];
  links?: Record<string, unknown>[];
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

  it("event <title> ends with — Daily, and its fallback is Daily", () => {
    const head = EventRoute.options.head as unknown as Head;
    const fallback = head({ loaderData: undefined }).meta ?? [];
    expect(fallback.find((m) => "title" in m)).toEqual({ title: "Daily" });
    const loaded = head({
      loaderData: { data: { title: "Chip export rules" } },
    });
    expect(loaded.meta?.find((m) => "title" in m)).toEqual({
      title: "Chip export rules — Daily",
    });
  });

  it("watch <title> ends with — Daily, and its fallback names the brand", () => {
    const head = WatchRoute.options.head as unknown as Head;
    const fallback = head({ loaderData: undefined }).meta ?? [];
    expect(fallback.find((m) => "title" in m)).toEqual({
      title: "Topic Watch — Daily",
    });
    const loaded = head({
      loaderData: {
        data: { watch: { question: "Any GPU news?", slug: "gpu" } },
      },
    });
    expect(loaded.meta?.find((m) => "title" in m)).toEqual({
      title: "Watch: Any GPU news? — Daily",
    });
  });

  it("digest <title> and feed link title carry Daily, and its fallback is Daily", () => {
    const head = DigestRoute.options.head as unknown as Head;
    const fallback = head({ loaderData: undefined }).meta ?? [];
    expect(fallback.find((m) => "title" in m)).toEqual({ title: "Daily" });
    const section = { name: "Technology", slug: "technology" };
    const daily = head({
      loaderData: {
        data: { kind: "daily", periodStart: "2026-10-26", section },
      },
    });
    expect(daily.meta?.find((m) => "title" in m)).toEqual({
      title: "Technology Daily Digest (2026-10-26) — Daily",
    });
    expect(daily.links?.[0]?.title).toBe("Daily — Technology Daily Digest");
    const weekly = head({
      loaderData: {
        data: { kind: "weekly", periodStart: "2026-10-19", section },
      },
    });
    expect(weekly.meta?.find((m) => "title" in m)).toEqual({
      title: "Technology Weekly Digest (Week of 2026-10-19) — Daily",
    });
  });

  it("the masthead name served to every page is Daily", async () => {
    await resetPublication();
    await seedSections();
    expect((await loadSiteShell()).name).toBe("Daily");
  });
});
