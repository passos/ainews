import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createSource,
  deleteSource,
  getSource,
  listSources,
  resumeSource,
  triggerCollect,
  updateSource,
} from "../../src/server/admin/ops";
import {
  getArticlePage,
  getSection,
} from "../../src/server/publication/articles";
import { db, resetPublication, seedSections } from "../publication/helpers";

// #87 A4 (owner decision): deleting a source keeps the row, so articles and
// article_sightings keep their foreign key and the articles stay on the site.
// The feed URL is rewritten to 'deleted:<id>:<url>': the source leaves the
// admin lists, cannot be resumed or collected, and its URL can be added again.
let industryId: number;

beforeEach(async () => {
  // resetPublication does not clear sightings, which reference articles.
  await env.DB.exec("DELETE FROM article_sightings");
  await resetPublication();
  const s = await seedSections();
  industryId = s.technology.industryId;
});

const newSource = (name: string, ind = industryId) =>
  createSource(env.DB, {
    industryId: ind,
    name,
    feedUrl: `https://${name}.example/feed`,
    kind: "rss",
  }) as Promise<number>;

/** An approved, grouped article of `sourceId`. */
const addApproved = async (sourceId: number, n: number) => {
  const row = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
     VALUES (?1, ?2, ?3, ?3, ?4, 'grouped', 0, ?5, 0) RETURNING id`,
  )
    .bind(
      sourceId,
      industryId,
      `https://x.example/${sourceId}-${n}`,
      `Title ${n}`,
      `sha-${n}`,
    )
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, ?2, 'approved', 'a@b.c', 0)",
  )
    .bind(row!.id, `sha-${n}`)
    .run();
  return row!.id;
};

const sighting = (articleId: number, sourceId: number) =>
  env.DB.prepare(
    "INSERT INTO article_sightings (article_id, source_id, seen_at) VALUES (?1, ?2, 0)",
  )
    .bind(articleId, sourceId)
    .run();

const raw = (id: number) =>
  env.DB.prepare(
    "SELECT id, name, feed_url, status, paused_reason FROM sources WHERE id = ?1",
  )
    .bind(id)
    .first<Record<string, unknown>>();
const listed = async (id: number) =>
  (await listSources(env.DB)).some((s) => s.id === id);
const status = async (p: Promise<unknown>) =>
  (await p.catch((e) => e)) as Response;

describe("listSources articleCount", () => {
  it("counts the articles of each source", async () => {
    const a = await newSource("a");
    const b = await newSource("b");
    const c = await newSource("c");
    const a1 = await addApproved(a, 1);
    await addApproved(a, 2);
    await sighting(a1, b); // a sighting is not an article of b
    const rows = await listSources(env.DB);
    const count = (id: number) => rows.find((r) => r.id === id)?.articleCount;
    expect(count(a)).toBe(2);
    expect(count(b)).toBe(0);
    expect(count(c)).toBe(0);
  });
});

describe("deleteSource (soft)", () => {
  it("hides the source but keeps its approved article on the site", async () => {
    const id = await newSource("wire");
    const articleId = await addApproved(id, 1);
    await deleteSource(env.DB, id);

    expect(await listed(id)).toBe(false);
    expect(await getSource(env.DB, id)).toBeNull();
    const row = await raw(id);
    expect(row?.feed_url).toBe(`deleted:${id}:https://wire.example/feed`);
    expect(row?.status).toBe("paused");
    expect(row?.paused_reason).toBeNull();

    // Public side: no filter on deleted sources, the article still shows its source.
    const section = await getSection(db(), { slug: "technology", page: 1 });
    expect(section?.articles.map((a) => a.id)).toEqual([articleId]);
    expect(section?.articles[0].sourceName).toBe("wire");
    const page = await getArticlePage(
      db(),
      { get: async () => null },
      articleId,
    );
    expect(page?.article.sourceName).toBe("wire");
  });

  it("a second delete, and an unknown id, are 400", async () => {
    const id = await newSource("twice");
    await deleteSource(env.DB, id);
    expect((await status(deleteSource(env.DB, id))).status).toBe(400);
    expect((await status(deleteSource(env.DB, 999_999))).status).toBe(400);
  });

  it("still protects system: sources", async () => {
    const sys = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Sys', 'system:test', 'rss', 'paused', 0) RETURNING id",
    )
      .bind(industryId)
      .first<{ id: number }>();
    expect((await status(deleteSource(env.DB, sys!.id))).status).toBe(400);
    expect((await raw(sys!.id))?.feed_url).toBe("system:test");
  });

  it("a deleted source cannot be resumed, collected or edited", async () => {
    const id = await newSource("gone");
    await deleteSource(env.DB, id);
    expect((await status(resumeSource(env.DB, id))).status).toBe(400);
    const sent: unknown[] = [];
    const q = { send: async (m: unknown) => void sent.push(m) };
    expect((await status(triggerCollect(env.DB, q, id))).status).toBe(400);
    expect(sent).toEqual([]);
    expect(
      (
        await status(
          updateSource(env.DB, {
            id,
            name: "x",
            feedUrl: "https://gone.example/feed",
          }),
        )
      ).status,
    ).toBe(400);
    expect((await raw(id))?.name).toBe("gone");
    // A live source still works.
    const live = await newSource("live");
    await triggerCollect(env.DB, q, live);
    expect(sent).toEqual([{ kind: "collect", sourceId: live }]);
  });
});

describe("adding the same URL after a delete", () => {
  it("creates a new row; the old articles stay on the old one", async () => {
    const old = await newSource("again");
    const articleId = await addApproved(old, 1);
    await deleteSource(env.DB, old);

    const fresh = await newSource("again");
    expect(fresh).not.toBe(old);
    expect(await listed(fresh)).toBe(true);
    expect(await listed(old)).toBe(false);
    const owner = await env.DB.prepare(
      "SELECT source_id FROM articles WHERE id = ?1",
    )
      .bind(articleId)
      .first<{ source_id: number }>();
    expect(owner?.source_id).toBe(old);
  });

  it("a live source with the same URL is still an error", async () => {
    await newSource("live");
    await expect(newSource("live")).rejects.toThrow();
  });
});
