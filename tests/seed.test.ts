// The #8 seed on the test D1: repeatable, never overwrites, and the stored
// rows (not the TS constants) pass the real parsers of #5 and #7.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  effectivePublishMode,
  FINANCE_SLUG,
} from "../src/pipeline/analyze/analyze";
import { parseAnalysisConfig } from "../src/pipeline/analyze/config";
import { LABELS } from "../src/pipeline/analyze/labels";
import { collectSource } from "../src/pipeline/collect/collect";
import { parseSourceConfig } from "../src/pipeline/collect/config";
import { parseFeed } from "../src/pipeline/collect/rss";
import { SEED_INDUSTRIES } from "../src/server/db/seed/industries";
import { buildSeedSql } from "../src/server/db/seed/sql";
import arxivXml from "./fixtures/feeds/arxiv-cs-ai.xml?raw";
import mitXml from "./fixtures/feeds/mit-tr.xml?raw";
import { realFixture } from "./fixtures/analysis/real-shape";
import {
  count,
  fakeFetch,
  fakeQueue,
  NOW,
  ON,
  pipelineEnv,
  resetPipeline,
} from "./pipeline/helpers";

const xml = (body: string) => () =>
  new Response(body, { headers: { "Content-Type": "application/xml" } });

interface IndustryRow {
  slug: string;
  name: string;
  publish_mode: "auto" | "review";
  disclaimer: string | null;
  primary_domains: string;
  config: string;
  created_at: number;
}

const industryRows = async () =>
  (
    await env.DB.prepare(
      "SELECT * FROM industries ORDER BY id",
    ).all<IndustryRow>()
  ).results;

const sourceRows = async () =>
  (
    await env.DB.prepare(
      `SELECT s.id, i.slug AS industry, s.name, s.feed_url, s.site_domain,
         s.kind, s.status, s.interval_minutes, s.next_fetch_at, s.config,
         s.jina_enabled, s.created_at
       FROM sources AS s JOIN industries AS i ON i.id = s.industry_id
       ORDER BY s.id`,
    ).all<{
      id: number;
      industry: string;
      name: string;
      feed_url: string;
      site_domain: string;
      kind: string;
      status: string;
      interval_minutes: number;
      next_fetch_at: number;
      config: string;
      jina_enabled: number;
      created_at: number;
    }>()
  ).results;

beforeEach(resetPipeline);

describe("buildSeedSql", () => {
  it("is one statement per line, and D1 exec runs every line", async () => {
    const sql = buildSeedSql(NOW);
    const lines = sql.split("\n");
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line).toMatch(/^INSERT INTO .*;$/);
    expect(sql.endsWith("\n")).toBe(false);
    const result = await env.DB.exec(sql);
    expect(result.count).toBe(6);
  });

  it("doubles every quote inside a string", () => {
    // "reader's" is in the Technology criteria.
    expect(buildSeedSql(NOW)).toContain("reader''s");
  });
});

describe("seed on the test database", () => {
  it("twice: 4 industries, 2 sources, no error", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    await env.DB.exec(buildSeedSql(NOW + 1000));
    expect(await count("SELECT count(*) AS n FROM industries")).toBe(4);
    expect(await count("SELECT count(*) AS n FROM sources")).toBe(2);
    // The second run changed nothing.
    for (const row of await industryRows()) expect(row.created_at).toBe(NOW);
  });

  it("every stored analysis config passes parseAnalysisConfig", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    const rows = await industryRows();
    expect(rows.map((r) => r.slug)).toEqual([
      "technology",
      "education",
      "industry",
      "finance",
    ]);
    for (const row of rows) {
      const config = parseAnalysisConfig(row.config);
      expect(config, row.slug).not.toBeNull();
      // Stored text equals the data: quotes and special characters survive.
      const seed = SEED_INDUSTRIES.find((i) => i.slug === row.slug)!;
      expect(config).toEqual(seed.analysis);
      expect(JSON.parse(row.primary_domains)).toEqual(seed.primaryDomains);
      // 4-8 categories; thresholds as the owner set them on 2026-10-23.
      const n = Object.keys(config!.categories).length;
      expect(n).toBeGreaterThanOrEqual(4);
      expect(n).toBeLessThanOrEqual(8);
      expect(config!.thresholds).toEqual({
        prefilterMinRelevant: 0.3,
        select: row.slug === "technology" ? 60 : 50,
      });
      // Every asked label is a known label.
      for (const key of config!.labels) expect(LABELS).toHaveProperty(key);
    }
  });

  it("publish_mode is review everywhere, only finance has a disclaimer", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    const rows = await industryRows();
    expect(rows.every((r) => r.publish_mode === "review")).toBe(true);
    expect(
      rows.filter((r) => r.disclaimer !== null).map((r) => r.slug),
    ).toEqual(["finance"]);
    expect(rows.find((r) => r.slug === "finance")!.disclaimer).toBe(
      "For information and education only. Not investment advice.",
    );
    // Finance also has its four guardrails; the others have none.
    for (const row of rows) {
      const guardrails = parseAnalysisConfig(row.config)!.guardrails;
      expect(guardrails).toHaveLength(row.slug === "finance" ? 4 : 0);
    }
    // The fourth Finance guardrail names period, benchmark and source (owner).
    const finance = parseAnalysisConfig(
      rows.find((r) => r.slug === "finance")!.config,
    )!;
    expect(finance.guardrails[3]).toBe(
      "Always say whether a performance claim comes from a backtest, a simulation or live use, and give the period, the benchmark it is compared with, and the source, when the source gives them.",
    );
    expect(finance.summaryGuidance).toContain("benchmark");
    expect(finance.summaryGuidance).toContain("source of the figures");
    // A paper is a preprint or peer reviewed, whichever the material says.
    const technology = parseAnalysisConfig(
      rows.find((r) => r.slug === "technology")!.config,
    )!;
    expect(technology.summaryGuidance).toContain(
      "whether it is a preprint or a peer-reviewed publication",
    );
  });

  it("the row with slug FINANCE_SLUG is never auto, even if set to auto", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    const row = await env.DB.prepare(
      "SELECT slug, publish_mode FROM industries WHERE slug = ?1",
    )
      .bind(FINANCE_SLUG)
      .first<{ slug: string; publish_mode: "auto" | "review" }>();
    expect(row).not.toBeNull();
    expect(effectivePublishMode(row!)).toBe("review");
    expect(effectivePublishMode({ ...row!, publish_mode: "auto" })).toBe(
      "review",
    );
  });

  it("does not overwrite what the admin changed or deleted", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE industries SET publish_mode = 'auto' WHERE slug = 'technology'",
      ),
      env.DB.prepare(
        "UPDATE sources SET interval_minutes = 15 WHERE feed_url LIKE '%arxiv%'",
      ),
      env.DB.prepare(
        "DELETE FROM sources WHERE feed_url LIKE '%technologyreview%'",
      ),
    ]);
    await env.DB.exec(buildSeedSql(NOW + 1000));
    const tech = (await industryRows()).find((r) => r.slug === "technology")!;
    expect(tech.publish_mode).toBe("auto");
    const sources = await sourceRows();
    // The deleted source is added again (its row is gone, so nothing
    // conflicts), the changed one is kept.
    expect(sources.map((s) => s.name)).toEqual([
      "arXiv cs.AI",
      "MIT Technology Review",
    ]);
    expect(sources[0].interval_minutes).toBe(15);
  });
});

describe("seed sources", () => {
  it("2 Technology sources with the fields of the issue", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    const rows = await sourceRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        industry: "technology",
        kind: "rss",
        status: "active",
        jina_enabled: 0,
        interval_minutes: 60,
        next_fetch_at: NOW,
        created_at: NOW,
      });
      // The real parser of #5; it throws on a wrong shape.
      parseSourceConfig(row.config);
    }
    expect(rows[0]).toMatchObject({
      name: "arXiv cs.AI",
      feed_url: "https://rss.arxiv.org/rss/cs.AI",
      site_domain: "arxiv.org",
    });
    expect(parseSourceConfig(rows[0].config)).toEqual({
      summaryIsBody: true,
      exclude: [
        { field: "arxiv:announce_type", values: ["replace", "replace-cross"] },
      ],
    });
    expect(rows[1]).toMatchObject({
      name: "MIT Technology Review",
      feed_url:
        "https://www.technologyreview.com/topic/artificial-intelligence/feed/",
      site_domain: "technologyreview.com",
    });
    expect(parseSourceConfig(rows[1].config)).toEqual({
      exclude: [{ field: "category", values: ["sponsored"] }],
    });
  });

  it("content_display: arXiv cs.AI full, MIT Technology Review excerpt", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    const { results } = await env.DB.prepare(
      "SELECT name, content_display FROM sources ORDER BY id",
    ).all<{ name: string; content_display: string }>();
    expect(results).toEqual([
      { name: "arXiv cs.AI", content_display: "full" },
      { name: "MIT Technology Review", content_display: "excerpt" },
    ]);
  });

  it("the seeded arXiv exclude keeps new + cross of the #5 snapshot", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    const [arxiv] = await sourceRows();
    const items = parseFeed(arxivXml, arxiv.feed_url);
    const kept = items.filter((i) =>
      ["new", "cross"].includes(i.fields["arxiv:announce_type"][0]),
    ).length;
    const q = fakeQueue();
    const result = await collectSource(
      pipelineEnv(q, ON),
      arxiv.id,
      NOW,
      fakeFetch(xml(arxivXml)),
    );
    expect(result).toMatchObject({
      status: "ok",
      items: 20,
      excluded: 20 - kept,
    });
    expect(kept).toBe(10);
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(kept);
  });

  it("the seeded MIT exclude drops the sponsored items of the snapshot", async () => {
    await env.DB.exec(buildSeedSql(NOW));
    const mit = (await sourceRows())[1];
    const items = parseFeed(mitXml, mit.feed_url);
    const sponsored = items.filter((i) =>
      i.fields.category?.includes("sponsored"),
    ).length;
    expect(sponsored).toBeGreaterThan(0);
    const result = await collectSource(
      pipelineEnv(fakeQueue(), ON),
      mit.id,
      NOW,
      fakeFetch(xml(mitXml)),
    );
    expect(result).toMatchObject({
      status: "ok",
      items: items.length,
      excluded: sponsored,
    });
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(
      items.length - sponsored,
    );
  });
});

describe("real fixtures for the trial run", () => {
  const files = import.meta.glob("./fixtures/analysis/real/*.json", {
    eager: true,
    import: "default",
  });
  const known = SEED_INDUSTRIES.map((i) => i.slug);

  it("10 files: 6 Technology, 1 Education, 1 Industry, 2 Finance", () => {
    const slugs = Object.values(files).map(
      (f) => realFixture.parse(f).industry,
    );
    expect(slugs).toHaveLength(10);
    const by = (slug: string) => slugs.filter((s) => s === slug).length;
    expect([
      by("technology"),
      by("education"),
      by("industry"),
      by("finance"),
    ]).toEqual([6, 1, 1, 2]);
  });

  it.each(Object.entries(files))(
    "%s has the shape and a known industry",
    (_name, value) => {
      const fixture = realFixture.parse(value);
      expect(known).toContain(fixture.industry);
      // Public text copied verbatim: at most 1,500 characters outside the
      // Technology snapshots, which come from the #5 feeds.
      if (fixture.industry !== "technology") {
        expect(fixture.body.length).toBeLessThanOrEqual(1500);
      }
    },
  );
});
