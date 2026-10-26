import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  NEWEST_FIRST,
  getHome,
  getRecentCorrections,
  getSection,
  getSectionFeed,
  getSectionSources,
} from "../../src/server/publication/articles";
import {
  db,
  resetPublication,
  seedAnalysis,
  seedArticle,
  seedCorrection,
  seedReview,
  seedSections,
} from "./helpers";

let tech: { industryId: number; sourceId: number };
let ids: number[];

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
  // 1: approved at the current body_sha. 2: no review. 3: rejected.
  // 4: approved, but for an older body version.
  ids = [];
  for (const title of ["Approved", "No review", "Rejected", "Old approval"]) {
    ids.push(await seedArticle({ ...tech, title }));
  }
  await seedReview(ids[0], "approved");
  await seedReview(ids[2], "rejected");
  await seedReview(ids[3], "approved", "sha-old");
});

describe("only approved articles are public", () => {
  it("getSection returns only the article approved at the current sha", async () => {
    const page = await getSection(db(), { slug: "technology", page: 1 });
    expect(page?.articles.map((a) => a.id)).toEqual([ids[0]]);
  });

  it("getSectionFeed returns only the article approved at the current sha", async () => {
    const feed = await getSectionFeed(db(), "technology");
    expect(feed?.articles.map((a) => a.id)).toEqual([ids[0]]);
  });

  it("getHome returns only the approved article", async () => {
    const home = await getHome(db());
    const all = home.sections.flatMap((s) => s.articles.map((a) => a.id));
    expect(all).toEqual([ids[0]]);
  });

  it("a newer body version drops an earlier approval", async () => {
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare(
      "UPDATE articles SET body_sha = 'sha-new' WHERE id = ?1",
    )
      .bind(ids[0])
      .run();
    const page = await getSection(db(), { slug: "technology", page: 1 });
    expect(page?.articles).toEqual([]);
  });

  it("a rejection at the current sha hides an approved article", async () => {
    const { env } = await import("cloudflare:workers");
    // Take down: a second review row cannot exist for the same sha (unique),
    // so the decision is flipped, as the admin "take down" action does.
    await env.DB.prepare(
      "UPDATE reviews SET decision = 'rejected' WHERE article_id = ?1",
    )
      .bind(ids[0])
      .run();
    const feed = await getSectionFeed(db(), "technology");
    expect(feed?.articles).toEqual([]);
  });

  it("an unknown slug returns null", async () => {
    expect(await getSection(db(), { slug: "nope", page: 1 })).toBeNull();
    expect(await getSectionFeed(db(), "nope")).toBeNull();
  });
});

describe("article links", () => {
  it("returns url = null for a non-http(s) url on every read path", async () => {
    const bad = await seedArticle({
      ...tech,
      title: "Bad link",
      url: "javascript:alert(1)",
    });
    const good = await seedArticle({
      ...tech,
      title: "Good link",
      url: "https://news.example/good",
    });
    await seedReview(bad, "approved");
    await seedReview(good, "approved");
    const urlOf = (list: { id: number; url: string | null }[], id: number) =>
      list.find((a) => a.id === id)?.url;
    const page = await getSection(db(), { slug: "technology", page: 1 });
    const feed = await getSectionFeed(db(), "technology");
    const home = await getHome(db());
    const homeAll = home.sections.flatMap((s) => s.articles);
    for (const list of [page!.articles, feed!.articles, homeAll]) {
      expect(urlOf(list, bad)).toBeNull();
      expect(urlOf(list, good)).toBe("https://news.example/good");
    }
  });
});

describe("corrections", () => {
  it("only corrections of approved articles are public", async () => {
    await seedCorrection("articles", ids[0], "Fixed the figure.", 10);
    await seedCorrection("articles", ids[1], "Unapproved correction.", 11);
    await seedCorrection("articles", ids[3], "Old approval correction.", 12);
    await seedCorrection("events", ids[0], "An event correction.", 13);

    const recent = await getRecentCorrections(db());
    expect(recent.map((c) => c.body)).toEqual(["Fixed the figure."]);

    const page = await getSection(db(), { slug: "technology", page: 1 });
    expect(page?.articles[0].correction).toBe("Fixed the figure.");
  });
});

describe("card correction", () => {
  it("shows the newest correction of the article; the highest id breaks a tie", async () => {
    const b = await seedArticle({ ...tech, title: "B" });
    await seedReview(b, "approved");
    await seedCorrection("articles", ids[0], "Older.", 10);
    await seedCorrection("articles", ids[0], "Newest first of a tie.", 20);
    await seedCorrection("articles", ids[0], "Newest, later id.", 20);
    await seedCorrection("articles", b, "Only one.", 5);
    const page = await getSection(db(), { slug: "technology", page: 1 });
    const body = (id: number) =>
      page?.articles.find((x) => x.id === id)?.correction;
    expect(body(ids[0])).toBe("Newest, later id.");
    expect(body(b)).toBe("Only one.");
  });
});

describe("card text", () => {
  it("title: override, then analysis, then feed title", async () => {
    const a = await seedArticle({ ...tech, title: "Feed title" });
    const b = await seedArticle({ ...tech, title: "Feed title B" });
    const c = await seedArticle({
      ...tech,
      title: "Feed title C",
      titleOverride: "Override C",
    });
    for (const id of [a, b, c]) await seedReview(id, "approved");
    await seedAnalysis(b, { titleEn: "Analysis B" });
    await seedAnalysis(c, { titleEn: "Analysis C" });
    const page = await getSection(db(), { slug: "technology", page: 1 });
    const title = (id: number) =>
      page?.articles.find((x) => x.id === id)?.title;
    expect(title(a)).toBe("Feed title");
    expect(title(b)).toBe("Analysis B");
    expect(title(c)).toBe("Override C");
  });

  it("summary: override, then analysis, then feed summary; newest analysis wins", async () => {
    const a = await seedArticle({
      ...tech,
      title: "A",
      summary: "Feed summary",
    });
    const b = await seedArticle({ ...tech, title: "B", summary: "Feed B" });
    const c = await seedArticle({
      ...tech,
      title: "C",
      summary: "Feed C",
      summaryOverride: "Override C",
    });
    for (const id of [a, b, c]) await seedReview(id, "approved");
    await seedAnalysis(b, {
      summaryEn: "Old analysis",
      createdAt: 1,
      promptVersion: "v1",
    });
    await seedAnalysis(b, {
      summaryEn: "New analysis",
      createdAt: 2,
      promptVersion: "v2",
    });
    await seedAnalysis(c, { summaryEn: "Analysis C" });
    const page = await getSection(db(), { slug: "technology", page: 1 });
    const summary = (id: number) =>
      page?.articles.find((x) => x.id === id)?.summary;
    expect(summary(a)).toBe("Feed summary");
    expect(summary(b)).toBe("New analysis");
    expect(summary(c)).toBe("Override C");
  });

  it("evidence tags: skips uncertain and not_applicable", async () => {
    await seedAnalysis(ids[0], {
      evidence: {
        publication_status: "preprint",
        claim_mode: "uncertain",
        performance_basis: "not_applicable",
      },
    });
    const page = await getSection(db(), { slug: "technology", page: 1 });
    expect(page?.articles[0].evidence).toEqual(["preprint"]);
  });

  it("does not return the article body (no body field)", async () => {
    const page = await getSection(db(), { slug: "technology", page: 1 });
    expect(Object.keys(page!.articles[0])).not.toContain("body");
  });
});

describe("paging", () => {
  it("20 per page, ordered by published time then id, with hasMore", async () => {
    const created: number[] = [];
    for (let i = 0; i < 21; i++) {
      // Two articles share a published time: id breaks the tie.
      const id = await seedArticle({
        ...tech,
        title: `P${i}`,
        publishedAt: 100_000 + Math.floor(i / 2),
      });
      await seedReview(id, "approved");
      created.push(id);
    }
    const p1 = await getSection(db(), { slug: "technology", page: 1 });
    const p2 = await getSection(db(), { slug: "technology", page: 2 });
    expect(p1?.articles).toHaveLength(20);
    expect(p1?.hasMore).toBe(true);
    // 21 new + 1 approved from beforeEach = 22.
    expect(p2?.articles).toHaveLength(2);
    expect(p2?.hasMore).toBe(false);
    const seen = [...p1!.articles, ...p2!.articles].map((a) => a.id);
    expect(new Set(seen).size).toBe(22);
    // Newest first; ties by higher id first.
    expect(seen[0]).toBe(created[20]);
    expect(seen[1]).toBe(created[19]);
  });

  it("uses fetched time when the published time is unknown", async () => {
    const early = await seedArticle({
      ...tech,
      title: "early",
      publishedAt: 5_000_000,
    });
    const late = await seedArticle({
      ...tech,
      title: "late",
      publishedAt: null,
      fetchedAt: 9_000_000,
    });
    await seedReview(early, "approved");
    await seedReview(late, "approved");
    const page = await getSection(db(), { slug: "technology", page: 1 });
    expect(page?.articles.slice(0, 2).map((a) => a.id)).toEqual([late, early]);
  });
});

describe("sources", () => {
  it("never lists a system placeholder source, even if it is active", async () => {
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Primary documents (system)', 'system:primary-documents', 'html', 'active', 0)",
    )
      .bind(tech.industryId)
      .run();
    const sources = await getSectionSources(db(), "technology");
    expect(sources.map((s) => s.name)).toEqual(["Technology Wire"]);
  });

  it("lists active sources of the section only, with a link only when there is a domain", async () => {
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at) VALUES (?1, 'No domain', 'https://x.example/f', NULL, 'rss', 'active', 0), (?1, 'Paused', 'https://y.example/f', 'y.example', 'rss', 'paused', 0)",
    )
      .bind(tech.industryId)
      .run();
    const sources = await getSectionSources(db(), "technology");
    expect(sources).toEqual([
      { name: "No domain", homepage: null },
      { name: "Technology Wire", homepage: "https://technology.example/" },
    ]);
  });
});

describe("query plan", () => {
  it("reads the newest rows of a section from articles_industry_newest_idx, without a sort", async () => {
    const plan = await db().all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT a.title FROM articles a WHERE a.industry_id = ${tech.industryId}
      ORDER BY ${NEWEST_FIRST} LIMIT 5`);
    const details = plan.map((r) => r.detail).join("\n");
    expect(details).toContain("USING INDEX articles_industry_newest_idx");
    expect(details).not.toContain("TEMP B-TREE");
  });
});
