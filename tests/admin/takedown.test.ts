import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decideReview } from "../../src/server/admin/ops";
import { getDb } from "../../src/server/db/client";
import { getSection } from "../../src/server/publication/articles";

// #87 A3b: Remove from site and Restore both call decideReview. This test
// checks the public result of each flip and the event revision.
async function seed(slug: string) {
  const ind = await env.DB.prepare(
    "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES (?1, 'Takedown', 'review', 100) RETURNING id",
  )
    .bind(slug)
    .first<{ id: number }>();
  const src = await env.DB.prepare(
    "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Src', ?2, 'rss', 'active', 100) RETURNING id",
  )
    .bind(ind!.id, `https://${slug}.example/feed`)
    .first<{ id: number }>();
  const art = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
     VALUES (?1, ?2, ?3, ?3, 'Takedown article', 'grouped', 100, 'sha-t', 100)
     RETURNING id`,
  )
    .bind(src!.id, ind!.id, `https://${slug}.example/a`)
    .first<{ id: number }>();
  const ev = await env.DB.prepare(
    "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev', 0, 100, 100) RETURNING id",
  )
    .bind(ind!.id)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 100)",
  )
    .bind(ev!.id, art!.id)
    .run();
  return { articleId: art!.id, eventId: ev!.id };
}

async function publicIds(slug: string): Promise<number[]> {
  const page = await getSection(getDb(env.DB), { slug, page: 1 });
  return page!.articles.map((a) => a.id);
}

async function revision(eventId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT revision FROM events WHERE id = ?1")
    .bind(eventId)
    .first<{ revision: number }>();
  return row!.revision;
}

describe("remove from site and restore", () => {
  it("removes an approved article from public reads and restores it, bumping the event revision on each flip", async () => {
    const slug = "takedown-flip";
    const { articleId, eventId } = await seed(slug);
    const decide = (decision: "approved" | "rejected") =>
      decideReview(env.DB, {
        articleId,
        bodySha: "sha-t",
        decision,
        reviewer: "admin@example.com",
      });

    await decide("approved");
    expect(await publicIds(slug)).toEqual([articleId]);
    const approvedRevision = await revision(eventId);

    // Remove from site.
    await decide("rejected");
    expect(await publicIds(slug)).toEqual([]);
    expect(await revision(eventId)).toBe(approvedRevision + 1);

    // Restore.
    await decide("approved");
    expect(await publicIds(slug)).toEqual([articleId]);
    expect(await revision(eventId)).toBe(approvedRevision + 2);
  });

  it("returns 409 when the body changed since the page loaded", async () => {
    const { articleId } = await seed("takedown-stale");
    let status: number | undefined;
    try {
      await decideReview(env.DB, {
        articleId,
        bodySha: "sha-old",
        decision: "rejected",
        reviewer: "admin@example.com",
      });
    } catch (e) {
      status = e instanceof Response ? e.status : undefined;
    }
    expect(status).toBe(409);
  });
});
