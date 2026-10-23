import { env } from "cloudflare:workers";
import { parse } from "node-html-parser";
import { beforeEach, describe, expect, it } from "vitest";
import { parseFeedDate } from "../../src/lib/time";
import { collectSource } from "../../src/pipeline/collect/collect";
import { parseHtmlList } from "../../src/pipeline/collect/html-list";
import page from "../fixtures/lists/anthropic-news.html?raw";
import {
  count,
  fakeFetch,
  fakeQueue,
  NOW,
  ON,
  pipelineEnv,
  resetPipeline,
  seedIndustry,
  seedSource,
} from "./helpers";

const PAGE_URL = "https://www.anthropic.com/news";
// The table rows of the list. The link selector keeps /news/ posts: some
// rows link to product pages (/claude-opus-5-5) instead.
const LIST = {
  item: "li[data-listing-row]",
  link: 'a[class*="title-link"][href^="/news/"]',
  title: "h3",
  date: "time",
};

it("node-html-parser runs in workerd (assumption of #5)", () => {
  const root = parse(
    '<ul><li data-x><a class="t-link" href="/a">A &amp; B</a></li></ul>',
  );
  expect(root.querySelector('li[data-x] a[class*="link"]')?.text).toBe("A & B");
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
});

describe("parseHtmlList", () => {
  it("reads the Anthropic news snapshot with the configured selectors", () => {
    const items = parseHtmlList(page, PAGE_URL, LIST);
    expect(items.length).toBeGreaterThanOrEqual(10);
    for (const item of items) {
      expect(item.url).toMatch(/^https:\/\/www\.anthropic\.com\/news\/[\w-]+$/);
      expect(item.title.trim()).not.toBe("");
      expect(item.publishedRaw).toMatch(/^[A-Z][a-z]{2} \d{1,2}, 2026$/);
      expect(parseFeedDate(item.publishedRaw, "+00:00")).not.toBeNull();
    }
  });

  it("defaults: link = the item <a> or its first a[href]; title = link text; date = <time datetime>", () => {
    const html = `
      <a class="e" href="/x/1">One</a>
      <div class="e"><span>no link</span></div>
      <div class="e"><time datetime="2026-10-22T10:00:00Z">Oct 22</time><a href="https://o.org/2"> Two </a></div>`;
    expect(
      parseHtmlList(html, "https://site.org/list/", { item: ".e" }),
    ).toEqual([
      {
        url: "https://site.org/x/1",
        title: "One",
        summary: null,
        contentHtml: null,
        publishedRaw: null,
        fields: {},
      },
      {
        url: "https://o.org/2",
        title: "Two",
        summary: null,
        contentHtml: null,
        publishedRaw: "2026-10-22T10:00:00Z",
        fields: {},
      },
    ]);
  });

  it("reads the element text when dateAttr is missing", () => {
    const html = `<p class="e"><a href="/a">A</a><span class="d" data-t="">Oct 1, 2026</span></p>`;
    const [item] = parseHtmlList(html, "https://s.org/", {
      item: ".e",
      date: ".d",
      dateAttr: "data-t",
    });
    expect(item.publishedRaw).toBe("Oct 1, 2026");
  });
});

describe("collectSource on an html source", () => {
  beforeEach(resetPipeline);

  it("stores the list entries", async () => {
    const industry = await seedIndustry("ai");
    const id = await seedSource({
      industryId: industry,
      feedUrl: PAGE_URL,
      kind: "html",
      config: { list: LIST },
      utcOffset: "-07:00",
    });
    const n = parseHtmlList(page, PAGE_URL, LIST).length;
    const q = fakeQueue();
    const result = await collectSource(
      pipelineEnv(q, ON),
      id,
      NOW,
      fakeFetch(
        () => new Response(page, { headers: { "Content-Type": "text/html" } }),
      ),
    );
    expect(result).toMatchObject({ status: "ok", items: n });
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(n);
    // "Oct 14, 2026" in the source zone (-07:00).
    const row = await env.DB.prepare(
      "SELECT published_at FROM articles WHERE published_raw = 'Oct 14, 2026' LIMIT 1",
    ).first<{ published_at: number }>();
    expect(row?.published_at).toBe(Date.UTC(2026, 9, 14, 7));
  });

  it("fails an html source without list config", async () => {
    const industry = await seedIndustry("ai");
    const id = await seedSource({
      industryId: industry,
      feedUrl: PAGE_URL,
      kind: "html",
    });
    const result = await collectSource(
      pipelineEnv(fakeQueue(), ON),
      id,
      NOW,
      fakeFetch(() => new Response(page)),
    );
    expect(result).toEqual({
      status: "failed",
      error: "html source has no list config",
    });
  });
});
