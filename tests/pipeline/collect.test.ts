import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { USER_AGENT } from "../../src/lib/http";
import {
  collectSource,
  MAX_FEED_BYTES,
} from "../../src/pipeline/collect/collect";
import { parseFeed } from "../../src/pipeline/collect/rss";
import arxivXml from "../fixtures/feeds/arxiv-cs-ai.xml?raw";
import mitXml from "../fixtures/feeds/mit-tr.xml?raw";
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
  sourceRow,
} from "./helpers";

const ARXIV = "https://rss.arxiv.org/rss/cs.AI";
const MIT = "https://www.technologyreview.com/feed/";
const xml =
  (body: string, headers: HeadersInit = {}) =>
  () =>
    new Response(body, {
      headers: { "Content-Type": "application/xml", ...headers },
    });

describe("parseFeed on real snapshots", () => {
  it("reads 20 arXiv items with abs links, summaries and no content", () => {
    const items = parseFeed(arxivXml, ARXIV);
    expect(items).toHaveLength(20);
    for (const item of items) {
      // <link> has no version; guid has one.
      expect(item.url).toMatch(/^https:\/\/arxiv\.org\/abs\/\d{4}\.\d{4,5}$/);
      expect(item.title).not.toBe("");
      expect(item.contentHtml).toBeNull();
      // The prefix stays: #6/#8 use the summary as the body.
      expect(item.summary).toMatch(/^arXiv:\S+ Announce Type: \S+ Abstract: /);
      expect(item.publishedRaw).toBe("Fri, 23 Oct 2026 00:00:00 -0400");
      expect(item.fields["guid"]?.[0]).toMatch(/^oai:arXiv\.org:.+v\d+$/);
    }
    const types = items.map((i) => i.fields["arxiv:announce_type"]?.[0]);
    for (const t of ["new", "cross", "replace", "replace-cross"]) {
      expect(types.filter((x) => x === t).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("reads 10 MIT Technology Review items, all with content:encoded", () => {
    const items = parseFeed(mitXml, MIT);
    expect(items).toHaveLength(10);
    for (const item of items) {
      expect(item.url).toMatch(/^https:\/\/www\.technologyreview\.com\//);
      expect(item.contentHtml).toMatch(/<p/);
      expect(item.publishedRaw).toMatch(/^\w{3}, \d{2} \w{3} 2026 /);
    }
    // At least one sponsored item, for the exclude rule.
    expect(items.some((i) => i.fields.category?.includes("sponsored"))).toBe(
      true,
    );
  });

  it("reads Atom: rel=alternate or no rel, relative links against the feed URL", () => {
    const items = parseFeed(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
        <entry><title type="html">A &amp;lt;b&amp;gt;</title>
          <link rel="self" href="/self"/><link rel="alternate" href="/a"/>
          <summary>S</summary><content type="html">&lt;p&gt;C&lt;/p&gt;</content>
          <updated>2026-10-22T10:00:00Z</updated></entry>
        <entry><title>B</title><link href="https://other.org/b"/></entry>
        <entry><title>No link</title></entry>
      </feed>`,
      "https://blog.example.com/feed.atom",
    );
    expect(items.map((i) => i.url)).toEqual([
      "https://blog.example.com/a",
      "https://other.org/b",
    ]);
    expect(items[0]).toMatchObject({
      summary: "S",
      contentHtml: "<p>C</p>",
      publishedRaw: "2026-10-22T10:00:00Z",
    });
  });

  it("reads RSS 1.0 (RDF)", () => {
    const items = parseFeed(
      `<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>C</title></channel>
        <item><title>One</title><link>https://x.org/1</link><dc:date>2026-10-22</dc:date></item>
      </rdf:RDF>`,
      "https://x.org/rdf",
    );
    expect(items).toEqual([
      expect.objectContaining({
        url: "https://x.org/1",
        publishedRaw: "2026-10-22",
      }),
    ]);
  });

  it("throws on a document that is not a feed", () => {
    expect(() => parseFeed("<html><body>hi</body></html>", ARXIV)).toThrow();
  });
});

describe("collectSource", () => {
  let industryA: number;
  let industryB: number;
  beforeEach(async () => {
    await resetPipeline();
    industryA = await seedIndustry("a");
    industryB = await seedIndustry("b");
  });

  it("stores arXiv with exclude: rows = new + cross, published_at from pubDate", async () => {
    const id = await seedSource({
      industryId: industryA,
      feedUrl: ARXIV,
      config: {
        exclude: [
          {
            field: "arxiv:announce_type",
            values: ["replace", "replace-cross"],
          },
        ],
      },
    });
    const items = parseFeed(arxivXml, ARXIV);
    const newOrCross = items.filter((i) =>
      ["new", "cross"].includes(i.fields["arxiv:announce_type"][0]),
    ).length;
    const q = fakeQueue();
    const f = fakeFetch(xml(arxivXml));
    const result = await collectSource(pipelineEnv(q, ON), id, NOW, f);
    expect(result).toMatchObject({
      status: "ok",
      items: 20,
      excluded: 20 - newOrCross,
    });
    expect(newOrCross).toBe(10);
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(newOrCross);
    const row = await env.DB.prepare(
      "SELECT stage, fetched_at, stage_updated_at, published_at, published_raw, has_feed_content, requeue_count FROM articles LIMIT 1",
    ).first();
    expect(row).toEqual({
      stage: "collected",
      fetched_at: NOW,
      stage_updated_at: NOW,
      published_at: Date.UTC(2026, 9, 23, 4),
      published_raw: "Fri, 23 Oct 2026 00:00:00 -0400",
      has_feed_content: 0,
      requeue_count: 0,
    });
    expect(q.sent).toHaveLength(newOrCross);
    expect(q.sent.every((m) => m.kind === "body")).toBe(true);
  });

  it("stores MIT TR: content:encoded to R2 feed/{id}.html, published_at set", async () => {
    const id = await seedSource({ industryId: industryA, feedUrl: MIT });
    const q = fakeQueue();
    await collectSource(pipelineEnv(q, ON), id, NOW, fakeFetch(xml(mitXml)));
    const { results } = await env.DB.prepare(
      "SELECT id, url, published_at, has_feed_content FROM articles ORDER BY id",
    ).all<{
      id: number;
      url: string;
      published_at: number;
      has_feed_content: number;
    }>();
    expect(results).toHaveLength(10);
    const items = parseFeed(mitXml, MIT);
    for (const r of results) {
      expect(r.published_at).toBeGreaterThan(Date.UTC(2026, 0, 1));
      expect(r.has_feed_content).toBe(1);
      const obj = await env.BODIES.get(`feed/${r.id}.html`);
      expect(await obj?.text()).toBe(
        items.find((i) => i.url === r.url)?.contentHtml,
      );
    }
  });

  it("stores an article seen by two sources once, in the first source's industry", async () => {
    const a = await seedSource({ industryId: industryA, feedUrl: ARXIV });
    // Same entries under other URL forms: http, www., tracking params.
    const variant = arxivXml.replaceAll(
      /<link>https:\/\/arxiv\.org\/abs\/([^<]+)<\/link>/g,
      "<link>http://www.arxiv.org/abs/$1/?utm_source=rss</link>",
    );
    const b = await seedSource({
      industryId: industryB,
      feedUrl: "https://mirror.example/rss",
    });
    const q = fakeQueue();
    await collectSource(pipelineEnv(q, ON), a, NOW, fakeFetch(xml(arxivXml)));
    await collectSource(
      pipelineEnv(q, ON),
      b,
      NOW + 1,
      fakeFetch(xml(variant)),
    );
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(20);
    expect(await count("SELECT count(*) AS n FROM article_sightings")).toBe(40);
    expect(
      await count(
        "SELECT count(*) AS n FROM articles WHERE industry_id = ?1 AND source_id = ?2",
        industryA,
        a,
      ),
    ).toBe(20);
    // The fetch URL stays the one the first source gave.
    expect(
      await count(
        "SELECT count(*) AS n FROM articles WHERE url LIKE 'https://arxiv.org/abs/%'",
      ),
    ).toBe(20);
    expect(q.sent).toHaveLength(20);
  });

  it("stores an entry listed twice in one feed once", async () => {
    const id = await seedSource({ industryId: industryA, feedUrl: ARXIV });
    const item = /<item>[\s\S]*?<\/item>/.exec(arxivXml)![0];
    const twice = arxivXml.replace(item, item + item);
    const q = fakeQueue();
    const result = await collectSource(
      pipelineEnv(q, ON),
      id,
      NOW,
      fakeFetch(xml(twice)),
    );
    expect(result).toMatchObject({ items: 21 });
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(20);
    expect(q.sent).toHaveLength(20);
  });

  it("sends the configured User-Agent and conditional headers", async () => {
    const id = await seedSource({
      industryId: industryA,
      feedUrl: ARXIV,
      etag: '"v1"',
    });
    await env.DB.prepare(
      "UPDATE sources SET last_modified = 'Thu, 22 Oct 2026 00:00:00 GMT' WHERE id = ?1",
    )
      .bind(id)
      .run();
    const f = fakeFetch(
      xml(arxivXml, {
        ETag: '"v2"',
        "Last-Modified": "Fri, 23 Oct 2026 04:00:05 GMT",
      }),
    );
    await collectSource(pipelineEnv(fakeQueue(), ON), id, NOW, f);
    expect(f.requests).toHaveLength(1);
    const req = f.requests[0];
    expect(req.url).toBe(ARXIV);
    expect(req.headers.get("User-Agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toBe("PersonalNewsBot/1.0 (+https://news.ioenv.com)");
    expect(USER_AGENT).not.toMatch(
      /ClaudeBot|anthropic-ai|CCBot|ChatGPT-User/i,
    );
    expect(req.headers.get("If-None-Match")).toBe('"v1"');
    expect(req.headers.get("If-Modified-Since")).toBe(
      "Thu, 22 Oct 2026 00:00:00 GMT",
    );
    expect(await sourceRow(id)).toMatchObject({
      etag: '"v2"',
      last_modified: "Fri, 23 Oct 2026 04:00:05 GMT",
      last_ok_at: NOW,
    });
  });

  it("pauses a source after 5 failures in a row, without throwing", async () => {
    const id = await seedSource({ industryId: industryA, feedUrl: ARXIV });
    const e = pipelineEnv(fakeQueue(), ON);
    const fail = fakeFetch(() => new Response("down", { status: 503 }));
    for (let i = 1; i <= 4; i++) {
      expect(await collectSource(e, id, NOW + i, fail)).toEqual({
        status: "failed",
        error: "HTTP 503",
      });
    }
    expect(await sourceRow(id)).toMatchObject({
      status: "active",
      paused_reason: null,
      fail_count: 4,
      last_failed_at: NOW + 4,
      last_error: "HTTP 503",
    });
    const reject: typeof fetch = async () => {
      throw new Error("x".repeat(600));
    };
    expect(
      await collectSource(e, id, NOW + 5, { fetch: reject }),
    ).toMatchObject({ status: "failed" });
    const row = await sourceRow(id);
    expect(row).toMatchObject({
      status: "paused",
      paused_reason: "failing",
      fail_count: 5,
    });
    expect(row?.last_error).toHaveLength(500);
    // Paused: the next message does not fetch.
    const after = fakeFetch(xml(arxivXml));
    expect(await collectSource(e, id, NOW + 6, after)).toEqual({
      status: "skipped",
    });
    expect(after.requests).toHaveLength(0);
  });

  it("counts a 304 as success: fail_count back to 0, nothing stored", async () => {
    const id = await seedSource({
      industryId: industryA,
      feedUrl: ARXIV,
      failCount: 3,
      etag: '"v1"',
    });
    const q = fakeQueue();
    const result = await collectSource(
      pipelineEnv(q, ON),
      id,
      NOW,
      fakeFetch(() => new Response(null, { status: 304 })),
    );
    expect(result).toEqual({ status: "not_modified" });
    expect(await sourceRow(id)).toMatchObject({
      fail_count: 0,
      last_ok_at: NOW,
      etag: '"v1"',
      status: "active",
    });
    expect(q.sent).toHaveLength(0);
  });

  it("counts a body over 5 MB and an invalid config as failures", async () => {
    const id = await seedSource({ industryId: industryA, feedUrl: ARXIV });
    const e = pipelineEnv(fakeQueue(), ON);
    const big = fakeFetch(
      () => new Response(new Uint8Array(MAX_FEED_BYTES + 1)),
    );
    expect(await collectSource(e, id, NOW, big)).toMatchObject({
      status: "failed",
    });
    await env.DB.prepare(
      `UPDATE sources SET config = '{"lst":{}}' WHERE id = ?1`,
    )
      .bind(id)
      .run();
    expect(
      await collectSource(e, id, NOW, fakeFetch(xml(arxivXml))),
    ).toMatchObject({ status: "failed" });
    expect((await sourceRow(id))?.fail_count).toBe(2);
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(0);
  });

  it('does nothing while COLLECT_ENABLED is not "true"', async () => {
    const id = await seedSource({ industryId: industryA, feedUrl: ARXIV });
    const q = fakeQueue();
    const f = fakeFetch(xml(arxivXml));
    for (const flags of [
      {},
      { COLLECT_ENABLED: "false" },
      { COLLECT_ENABLED: "TRUE" },
    ]) {
      expect(await collectSource(pipelineEnv(q, flags), id, NOW, f)).toEqual({
        status: "disabled",
      });
    }
    expect(f.requests).toHaveLength(0);
    expect(q.sent).toHaveLength(0);
  });
});
