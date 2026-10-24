import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { USER_AGENT } from "../../src/lib/http";
import { normalizeUrl } from "../../src/lib/url";
import {
  arxivDays,
  backfillArxiv,
  backfillFeedPages,
  loadSource,
  parseBackfillArgs,
  type BackfillDeps,
} from "../../src/pipeline/collect/backfill";
import { parseArxivCatchup } from "../../src/pipeline/collect/catchup";
import { storeItems } from "../../src/pipeline/collect/collect";
import { isExcluded } from "../../src/pipeline/collect/config";
import { parseFeed } from "../../src/pipeline/collect/rss";
import { SEED_SOURCES } from "../../src/server/db/seed/sources";
import catchupHtml from "../fixtures/feeds/arxiv-catchup-cs-ai.html?raw";
import arxivXml from "../fixtures/feeds/arxiv-cs-ai.xml?raw";
import mitXml from "../fixtures/feeds/mit-tr.xml?raw";
import {
  count,
  fakeFetch,
  fakeQueue,
  pipelineEnv,
  resetPipeline,
  seedIndustry,
  seedSource,
} from "./helpers";

const ARXIV = "https://rss.arxiv.org/rss/cs.AI";
const MIT = "https://www.technologyreview.com/feed/";
const PAGE = "https://arxiv.org/catchup/cs.AI/2026-10-22?abs=True";
/** Fri 23 Oct 2026 12:00 UTC. */
const FRI = Date.UTC(2026, 9, 23, 12, 0, 0);
const HOUR = 60 * 60_000;

const seed = (name: string) => {
  const found = SEED_SOURCES.find((x) => x.name === name);
  if (!found) throw new Error(`no seed source ${name}`);
  return found;
};

describe("parseArxivCatchup", () => {
  const page = parseArxivCatchup(catchupHtml, PAGE);

  it("reads the date, the three sections and drops entries without id or title", () => {
    expect(page.date).toBe("Thu, 22 Oct 2026");
    expect(page.incomplete).toBe(false);
    // 3 New + 3 Cross + 4 Replacement; the 2 synthetic entries are dropped.
    expect(page.items).toHaveLength(10);
    expect(page.dropped).toBe(2);
    const types = page.items.map((i) => i.fields["arxiv:announce_type"]);
    expect(types).toEqual([
      ...Array(3).fill(["new"]),
      ...Array(3).fill(["cross"]),
      ...Array(4).fill(["replace"]),
    ]);
    expect(page.items.map((i) => i.url)).not.toContain(
      "https://arxiv.org/abs/2610.99999",
    );
  });

  it("gives items the shape of the RSS items", () => {
    for (const item of page.items) {
      expect(item.url).toMatch(/^https:\/\/arxiv\.org\/abs\/\d{4}\.\d{4,5}$/);
      expect(item.title).not.toBe("");
      expect(item.contentHtml).toBeNull();
      expect(item.summary).toMatch(/^arXiv:\S+ Announce Type: \S+ Abstract: /);
      // The RSS pubDate of an announcement day: midnight in New York.
      expect(item.publishedRaw).toBe("Thu, 22 Oct 2026 00:00:00 -0400");
    }
    const [first, second] = page.items;
    expect(first.url).toBe("https://arxiv.org/abs/2610.28686");
    expect(first.title).toBe(
      "A Small Model Asks Better: Fine-Tuning Query Clarification for Retrieval-Augmented Generation",
    );
    expect(first.summary).toMatch(
      /^arXiv:2610\.28686 Announce Type: new Abstract: Query clarification is essential/,
    );
    expect(first.fields.category).toEqual(["cs.AI"]);
    expect(second.fields.category).toEqual(["cs.AI", "cs.CV", "cs.LG"]);
    const cross = page.items[3];
    expect(cross.url).toBe("https://arxiv.org/abs/2610.22714");
  });

  it("decodes HTML entities in titles and abstracts", () => {
    const titles = page.items.map((i) => i.title);
    expect(titles).toContain(
      "From Atomic to Agentic: Towards Interpretable Evaluation of LLMs' Agentic Mathematical Capabilities",
    );
    expect(page.items.some((i) => i.summary?.includes("Generative AI's"))).toBe(
      true,
    );
    for (const item of page.items) {
      expect(`${item.title} ${item.summary}`).not.toMatch(/&#?\w+;/);
    }
  });

  it("drops the Replacement section by the arXiv source config, as RSS does", () => {
    const { exclude } = seed("arXiv cs.AI").config;
    const kept = page.items.filter((i) => !isExcluded(i.fields, exclude));
    expect(kept).toHaveLength(6);
    expect(
      kept.every((i) =>
        ["new", "cross"].includes(i.fields["arxiv:announce_type"][0]),
      ),
    ).toBe(true);
    // The RSS feed uses the same values for the same sections.
    const rssTypes = new Set(
      parseFeed(arxivXml, ARXIV).map((i) => i.fields["arxiv:announce_type"][0]),
    );
    for (const t of ["new", "cross", "replace"]) expect(rssTypes).toContain(t);
  });

  it("has the canonical URL and pubDate of the RSS item for the same paper", () => {
    const rss = parseFeed(arxivXml, ARXIV)[0];
    expect(rss.url).toBe("https://arxiv.org/abs/2610.30151");
    const same = parseArxivCatchup(
      catchupHtml
        .replaceAll("2610.28686", "2610.30151")
        .replaceAll("Thu, 22 Oct 2026", "Fri, 23 Oct 2026"),
      PAGE,
    ).items[0];
    expect(normalizeUrl(same.url)).toBe(normalizeUrl(rss.url));
    expect(same.publishedRaw).toBe(rss.publishedRaw);
  });

  it("uses the New York offset of the day (EST after 1 Nov 2026)", () => {
    const winter = parseArxivCatchup(
      catchupHtml.replaceAll("Thu, 22 Oct 2026", "Mon, 2 Nov 2026"),
      PAGE,
    );
    expect(winter.items[0].publishedRaw).toBe("Mon, 2 Nov 2026 00:00:00 -0500");
  });

  it("flags a section that shows fewer entries than it has", () => {
    const cut = parseArxivCatchup(
      catchupHtml.replace("showing 63 of 63", "showing 50 of 63"),
      PAGE,
    );
    expect(cut.incomplete).toBe(true);
  });

  it("tolerates a page with no sections", () => {
    const empty = parseArxivCatchup(
      "<html><body><h1>x</h1></body></html>",
      PAGE,
    );
    expect(empty).toEqual({
      date: null,
      items: [],
      dropped: 0,
      incomplete: false,
    });
  });
});

describe("arxivDays", () => {
  it("lists the weekdays whose midnight in New York is in the window, newest first", () => {
    // Cutoff Tue 20 Oct 12:00 UTC: Tue 20 starts at 04:00 UTC, before it.
    expect(arxivDays(FRI, 3)).toEqual([
      "2026-10-23",
      "2026-10-22",
      "2026-10-21",
    ]);
  });

  it("skips Saturday and Sunday", () => {
    const mon = Date.UTC(2026, 9, 26, 12, 0, 0);
    expect(arxivDays(mon, 3)).toEqual(["2026-10-26"]);
    expect(arxivDays(mon, 4)).toEqual(["2026-10-26", "2026-10-23"]);
  });
});

describe("parseBackfillArgs", () => {
  it("defaults to a dry run of 3 days on the local database", () => {
    expect(parseBackfillArgs([])).toEqual({
      apply: false,
      days: 3,
      remote: false,
    });
  });

  it("reads --apply, --days and --remote; rejects anything else", () => {
    expect(parseBackfillArgs(["--apply", "--days", "2", "--remote"])).toEqual({
      apply: true,
      days: 2,
      remote: true,
    });
    expect(() => parseBackfillArgs(["--days", "0"])).toThrow();
    expect(() => parseBackfillArgs(["--days"])).toThrow();
    expect(() => parseBackfillArgs(["--dry"])).toThrow();
    expect(() => parseBackfillArgs(["--apply", "--dry-run"])).toThrow();
  });
});

const ROBOTS = "User-agent: *\nCrawl-delay: 15\nAllow: /\n";
const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });
const xml = (body: string) =>
  new Response(body, { headers: { "Content-Type": "application/xml" } });

/** arxiv.org: robots.txt, the fixture for 22 Oct, another day's h1 otherwise. */
function arxivFetch(robots = ROBOTS) {
  return fakeFetch((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/robots.txt") return new Response(robots);
    if (url.pathname === "/catchup/cs.AI/2026-10-22") return html(catchupHtml);
    // No announcement: arXiv shows another day (assumed; any other date).
    return html(
      "<h1>Catchup results for Artificial Intelligence on Mon, 19 Oct 2026</h1>",
    );
  });
}

function deps(f: ReturnType<typeof fakeFetch>): BackfillDeps & {
  sleeps: number[];
} {
  const sleeps: number[] = [];
  return {
    fetch: f.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps,
  };
}

async function tableCounts() {
  const tables = ["articles", "article_sightings", "fetch_hosts", "sources"];
  const out: Record<string, number> = {};
  for (const t of tables)
    out[t] = await count(`SELECT count(*) AS n FROM ${t}`);
  const { objects } = await env.BODIES.list({ prefix: "feed/" });
  out.r2 = objects.length;
  return out;
}

describe("backfill", () => {
  let industryId: number;
  let arxivId: number;
  let mitId: number;

  beforeEach(async () => {
    await resetPipeline();
    industryId = await seedIndustry("technology");
    arxivId = await seedSource({
      industryId,
      feedUrl: ARXIV,
      config: seed("arXiv cs.AI").config,
      siteDomain: "arxiv.org",
    });
    mitId = await seedSource({
      industryId,
      feedUrl: MIT,
      config: seed("MIT Technology Review").config,
      siteDomain: "technologyreview.com",
    });
  });

  it("stores a paper seen by RSS and by catchup once (same canonical URL)", async () => {
    const q = fakeQueue();
    const e = pipelineEnv(q);
    const source = (await loadSource(env.DB, ARXIV))!;
    const rss = parseFeed(arxivXml, ARXIV).slice(0, 1);
    const first = await storeItems(e, source, rss, FRI);
    expect(first.inserted).toHaveLength(1);
    const catchup = parseArxivCatchup(
      catchupHtml.replaceAll("2610.28686", "2610.30151"),
      PAGE,
    ).items.slice(0, 1);
    const second = await storeItems(e, source, catchup, FRI + HOUR);
    expect(second).toEqual({ inserted: [], sightings: 0 });
    expect(
      await count(
        "SELECT count(*) AS n FROM articles WHERE canonical_url = ?1",
        "https://arxiv.org/abs/2610.30151",
      ),
    ).toBe(1);
  });

  it("dry run: requests through robots.txt, reports, writes nothing", async () => {
    const q = fakeQueue();
    const f = arxivFetch();
    const d = deps(f);
    const before = await tableCounts();
    const source = (await loadSource(env.DB, ARXIV))!;
    const report = await backfillArxiv(
      pipelineEnv(q),
      source,
      { apply: false, days: 3, now: FRI },
      d,
    );
    expect(report).toMatchObject({
      sourceId: arxivId,
      fetched: 10,
      dropped: 2,
      excluded: 4,
      stale: 0,
      kept: 6,
      existing: 0,
      fresh: 6,
      inserted: null,
      oldest: Date.UTC(2026, 9, 22, 4),
      newest: Date.UTC(2026, 9, 22, 4),
    });
    expect(report.samples).toHaveLength(3);
    expect(report.pages).toEqual([
      "2026-10-23: no announcement (page is for Mon, 19 Oct 2026)",
      "2026-10-22: 10 entries",
      "2026-10-21: no announcement (page is for Mon, 19 Oct 2026)",
    ]);
    expect(await tableCounts()).toEqual(before);
    expect(q.sent).toEqual([]);
    // Every page request comes after a robots.txt check, with the UA.
    const paths = f.requests.map((r) => new URL(r.url).pathname);
    expect(paths.filter((p) => p.startsWith("/catchup/"))).toHaveLength(3);
    for (let i = 0; i < paths.length; i++) {
      if (paths[i].startsWith("/catchup/")) {
        expect(paths[i - 1]).toBe("/robots.txt");
      }
    }
    for (const r of f.requests) {
      expect(r.headers.get("User-Agent")).toBe(USER_AGENT);
    }
    // 15 s between the 3 page requests.
    expect(d.sleeps).toEqual([15_000, 15_000]);
  });

  it("dry run counts the papers that are already stored", async () => {
    const q = fakeQueue();
    const source = (await loadSource(env.DB, ARXIV))!;
    const page = parseArxivCatchup(catchupHtml, PAGE).items.slice(0, 2);
    await storeItems(pipelineEnv(q), source, page, FRI);
    const report = await backfillArxiv(
      pipelineEnv(q),
      source,
      { apply: false, days: 3, now: FRI },
      deps(arxivFetch()),
    );
    expect(report).toMatchObject({ kept: 6, existing: 2, fresh: 4 });
  });

  it("apply: stores and sends body messages; a second apply inserts 0", async () => {
    const q = fakeQueue();
    const source = (await loadSource(env.DB, ARXIV))!;
    const opts = { apply: true, days: 3, now: FRI };
    const first = await backfillArxiv(
      pipelineEnv(q),
      source,
      opts,
      deps(arxivFetch()),
    );
    expect(first).toMatchObject({ kept: 6, fresh: 6, inserted: 6 });
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(6);
    expect(
      await count(
        "SELECT count(*) AS n FROM articles WHERE stage = 'collected' AND stage_updated_at = ?1",
        FRI,
      ),
    ).toBe(6);
    expect(q.sent).toHaveLength(6);
    expect(q.sent.every((m) => m.kind === "body")).toBe(true);
    const second = await backfillArxiv(
      pipelineEnv(q),
      source,
      { ...opts, now: FRI + HOUR },
      deps(arxivFetch()),
    );
    expect(second).toMatchObject({ existing: 6, fresh: 0, inserted: 0 });
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(6);
    expect(q.sent).toHaveLength(6);
  });

  it("does not request a page that robots.txt disallows", async () => {
    const f = arxivFetch("User-agent: *\nDisallow: /catchup\n");
    const source = (await loadSource(env.DB, ARXIV))!;
    await expect(
      backfillArxiv(
        pipelineEnv(fakeQueue()),
        source,
        { apply: true, days: 3, now: FRI },
        deps(f),
      ),
    ).rejects.toThrow("robots_disallowed");
    expect(f.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/robots.txt",
    ]);
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(0);
  });

  it("counts a 404 day as no announcement and stops on other errors", async () => {
    const respond = (status: number) =>
      fakeFetch((req) => {
        const url = new URL(req.url);
        if (url.pathname === "/robots.txt") return new Response(ROBOTS);
        if (url.pathname === "/catchup/cs.AI/2026-10-22") {
          return html(catchupHtml);
        }
        return new Response("", { status });
      });
    const source = (await loadSource(env.DB, ARXIV))!;
    const opts = { apply: false, days: 3, now: FRI };
    const report = await backfillArxiv(
      pipelineEnv(fakeQueue()),
      source,
      opts,
      deps(respond(404)),
    );
    expect(report.pages).toEqual([
      "2026-10-23: HTTP 404, no announcement",
      "2026-10-22: 10 entries",
      "2026-10-21: HTTP 404, no announcement",
    ]);
    expect(report.kept).toBe(6);
    await expect(
      backfillArxiv(pipelineEnv(fakeQueue()), source, opts, deps(respond(503))),
    ).rejects.toThrow("HTTP 503");
  });

  it("refuses a catchup page that does not show all its entries", async () => {
    const f = fakeFetch((req) =>
      new URL(req.url).pathname === "/robots.txt"
        ? new Response(ROBOTS)
        : html(catchupHtml.replace("showing 63 of 63", "showing 50 of 63")),
    );
    const source = (await loadSource(env.DB, ARXIV))!;
    await expect(
      backfillArxiv(
        pipelineEnv(fakeQueue()),
        source,
        { apply: true, days: 1, now: FRI },
        deps(f),
      ),
    ).rejects.toThrow(/does not show all entries/);
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(0);
  });

  it("feed pages: drops items older than the window and stops at the first page that reaches it", async () => {
    // Sat 24 Oct 10:00 UTC - 3 days = Wed 21 Oct 10:00 UTC: the three
    // items of Wed 21 Oct 09:00 are older; the 4 sponsored ones are excluded.
    const now = Date.UTC(2026, 9, 24, 10, 0, 0);
    const f = fakeFetch((req) =>
      new URL(req.url).pathname === "/robots.txt"
        ? new Response("User-agent: *\nAllow: /\n")
        : xml(mitXml),
    );
    const q = fakeQueue();
    const source = (await loadSource(env.DB, MIT))!;
    const report = await backfillFeedPages(
      pipelineEnv(q),
      source,
      { apply: true, days: 3, now },
      deps(f),
    );
    expect(report).toMatchObject({
      sourceId: mitId,
      fetched: 10,
      excluded: 4,
      stale: 3,
      kept: 3,
      inserted: 3,
      oldest: Date.UTC(2026, 9, 21, 12, 10),
    });
    expect(report.pages).toEqual([`${MIT}: 10 items`]);
    const stored = await env.DB.prepare(
      "SELECT min(published_at) AS m FROM articles",
    ).first<{ m: number }>();
    expect(stored!.m).toBeGreaterThanOrEqual(now - 3 * 24 * HOUR);
    // content:encoded goes to R2 as in the cron path.
    const { objects } = await env.BODIES.list({ prefix: "feed/" });
    expect(objects).toHaveLength(3);
  });

  it("feed pages: pages with ?paged=N, at most 5 pages, spaced", async () => {
    // Every item is newer than the window: paging only ends at 5 pages.
    const now = Date.UTC(2026, 9, 23, 0, 0, 0);
    const f = fakeFetch((req) =>
      new URL(req.url).pathname === "/robots.txt"
        ? new Response("User-agent: *\nAllow: /\n")
        : xml(mitXml),
    );
    const d = deps(f);
    const source = (await loadSource(env.DB, MIT))!;
    const report = await backfillFeedPages(
      pipelineEnv(fakeQueue()),
      source,
      { apply: false, days: 3, now },
      d,
    );
    const pages = f.requests
      .map((r) => r.url)
      .filter((u) => !u.endsWith("/robots.txt"));
    expect(pages).toEqual([
      MIT,
      `${MIT}?paged=2`,
      `${MIT}?paged=3`,
      `${MIT}?paged=4`,
      `${MIT}?paged=5`,
    ]);
    expect(d.sleeps).toHaveLength(4);
    // The same 6 kept items on every page count once.
    expect(report).toMatchObject({ fetched: 50, kept: 30, fresh: 6 });
  });

  it("feed pages: a 404 after the first page ends paging", async () => {
    const now = Date.UTC(2026, 9, 23, 0, 0, 0);
    const f = fakeFetch((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/robots.txt") return new Response("");
      return url.searchParams.has("paged")
        ? new Response("not found", { status: 404 })
        : xml(mitXml);
    });
    const source = (await loadSource(env.DB, MIT))!;
    const report = await backfillFeedPages(
      pipelineEnv(fakeQueue()),
      source,
      { apply: false, days: 3, now },
      deps(f),
    );
    expect(report.pages).toEqual([
      `${MIT}: 10 items`,
      `${MIT}?paged=2: HTTP 404, stop`,
    ]);
  });
});
