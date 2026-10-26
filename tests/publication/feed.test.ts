import { beforeEach, describe, expect, it } from "vitest";
import { SITE_NAME } from "../../src/lib/site";
import { feedResponse } from "../../src/server/publication/feed";
import {
  DISCLAIMER,
  db,
  resetPublication,
  seedAnalysis,
  seedArticle,
  seedReview,
  seedSections,
} from "./helpers";

const SITE = "https://news.example.test";

beforeEach(async () => {
  await resetPublication();
});

async function fetchFeed(slug: string) {
  const res = await feedResponse(db(), SITE, slug);
  return { res, xml: await res.text() };
}

describe("feedResponse", () => {
  it("is RSS 2.0 with the right headers", async () => {
    await seedSections();
    const { res, xml } = await fetchFeed("technology");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain(`<title>${SITE_NAME} — Technology</title>`);
    expect(xml).toContain(`<link>${SITE}/s/technology</link>`);
  });

  it("returns 404 for an unknown section, without RSS content", async () => {
    await seedSections();
    const { res, xml } = await fetchFeed("nope");
    expect(res.status).toBe(404);
    expect(xml).not.toContain("<rss");
  });

  it("escapes markup in titles, summaries and sources", async () => {
    const { technology: t } = await seedSections();
    const id = await seedArticle({
      ...t,
      title: "<script>alert(1)</script> & more",
      summary: 'Summary with <b>tags</b> & "quotes"',
      url: "https://news.example/a?x=1&y=2",
    });
    await seedReview(id, "approved");
    const { xml } = await fetchFeed("technology");
    expect(xml).toContain(
      "<title>&lt;script&gt;alert(1)&lt;/script&gt; &amp; more</title>",
    );
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("<b>tags</b>");
    expect(xml).toContain("<link>https://news.example/a?x=1&amp;y=2</link>");
  });

  it("omits <link> for an item whose url is not http(s)", async () => {
    const { technology: t } = await seedSections();
    const bad = await seedArticle({
      ...t,
      title: "Bad link",
      url: "javascript:alert(1)",
    });
    const good = await seedArticle({
      ...t,
      title: "Good link",
      url: "https://news.example/good",
    });
    await seedReview(bad, "approved");
    await seedReview(good, "approved");
    const { xml } = await fetchFeed("technology");
    expect(xml).not.toContain("javascript:");
    const items = xml.split("<item>").slice(1);
    expect(items).toHaveLength(2);
    const badItem = items.find((i) => i.includes("Bad link"))!;
    const goodItem = items.find((i) => i.includes("Good link"))!;
    expect(badItem).not.toContain("<link>");
    expect(goodItem).toContain("<link>https://news.example/good</link>");
  });

  it("item: guid is the article id, not a permalink; pubDate is UTC; source named", async () => {
    const { technology: t } = await seedSections();
    const id = await seedArticle({
      ...t,
      title: "Item",
      summary: "S.",
      publishedAt: Date.UTC(2026, 9, 22, 2, 5),
    });
    await seedReview(id, "approved");
    const { xml } = await fetchFeed("technology");
    expect(xml).toContain(`<guid isPermaLink="false">${id}</guid>`);
    expect(xml).toContain("<pubDate>Thu, 22 Oct 2026 02:05:00 GMT</pubDate>");
    expect(xml).toContain("Source: Technology Wire");
  });

  it("puts the disclaimer in the channel description and every item", async () => {
    const { finance: f } = await seedSections();
    for (const title of ["One", "Two"]) {
      const id = await seedArticle({ ...f, title, summary: "Summary." });
      await seedReview(id, "approved");
    }
    const { xml } = await fetchFeed("finance");
    const channel = xml.split("<item>")[0];
    expect(channel).toContain(DISCLAIMER);
    const items = xml.split("<item>").slice(1);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item).toContain(DISCLAIMER);
  });

  it("adds no disclaimer text to a section without one", async () => {
    const { technology: t } = await seedSections();
    const id = await seedArticle({ ...t, title: "T", summary: "S" });
    await seedReview(id, "approved");
    const { xml } = await fetchFeed("technology");
    expect(xml).not.toContain("Not investment advice");
  });

  it("lists at most 50 approved items, newest first", async () => {
    const { technology: t } = await seedSections();
    for (let i = 0; i < 52; i++) {
      const id = await seedArticle({
        ...t,
        title: `N${i}`,
        publishedAt: 1_000_000 + i,
      });
      await seedReview(id, "approved");
    }
    const { xml } = await fetchFeed("technology");
    expect(xml.match(/<item>/g)).toHaveLength(50);
    expect(xml.indexOf("<title>N51</title>")).toBeLessThan(
      xml.indexOf("<title>N50</title>"),
    );
    expect(xml).not.toContain("<title>N1</title>");
  });

  it("does not list unapproved articles", async () => {
    const { technology: t } = await seedSections();
    const id = await seedArticle({ ...t, title: "Hidden" });
    await seedReview(id, "rejected");
    const { xml } = await fetchFeed("technology");
    expect(xml).not.toContain("Hidden");
  });

  it("uses analysis text when present and ignores analysis-free summaries as null", async () => {
    const { technology: t } = await seedSections();
    const id = await seedArticle({ ...t, title: "Feed", summary: null });
    await seedReview(id, "approved");
    await seedAnalysis(id, {
      titleEn: "Better title",
      summaryEn: "Better summary.",
    });
    const { xml } = await fetchFeed("technology");
    expect(xml).toContain("<title>Better title</title>");
    expect(xml).toContain("Better summary.");
  });
});
