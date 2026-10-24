import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decideReview } from "../../src/server/admin/ops";
import { revisionBumpStatement } from "../../src/server/db/events";

describe("event revision bumping", () => {
  it("revisionBumpStatement increments revision of the article's event and updates updated_at", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('rev-ind-1', 'Rev 1', 'review', 100) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Src', 'https://e1.com/feed', 'rss', 'active', 100) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://e1.com/art1', 'https://e1.com/art1', 'Art 1', 'analyzed', 100, 'sha-1', 100)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    const artId = art!.id;

    const ev = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev 1', 0, 100, 100) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const eventId = ev!.id;

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 100)",
    )
      .bind(eventId, artId)
      .run();

    // Bump revision
    await revisionBumpStatement(env.DB, artId, 200).run();

    const updatedEv = await env.DB.prepare(
      "SELECT revision, updated_at FROM events WHERE id = ?1",
    )
      .bind(eventId)
      .first<{ revision: number; updated_at: number }>();

    expect(updatedEv?.revision).toBe(1);
    expect(updatedEv?.updated_at).toBe(200);

    // Bump for non-existent article does not throw or change anything
    await revisionBumpStatement(env.DB, 999999, 300).run();
    const sameEv = await env.DB.prepare(
      "SELECT revision, updated_at FROM events WHERE id = ?1",
    )
      .bind(eventId)
      .first<{ revision: number; updated_at: number }>();
    expect(sameEv?.revision).toBe(1);
    expect(sameEv?.updated_at).toBe(200);
  });

  it("decideReview increments revision only when approval status flips", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('rev-ind-2', 'Rev 2', 'review', 100) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Src 2', 'https://e2.com/feed', 'rss', 'active', 100) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://e2.com/art2', 'https://e2.com/art2', 'Art 2', 'analyzed', 100, 'sha-2', 100)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    const artId = art!.id;

    const ev = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev 2', 0, 100, 100) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const eventId = ev!.id;

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 100)",
    )
      .bind(eventId, artId)
      .run();

    // 1. Pending -> Approved: revision 0 -> 1
    await decideReview(env.DB, {
      articleId: artId,
      bodySha: "sha-2",
      decision: "approved",
      reviewer: "admin@test.com",
    });

    let evRow = await env.DB.prepare(
      "SELECT revision FROM events WHERE id = ?1",
    )
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(1);

    // 2. Approved -> Approved again: revision stays 1
    await decideReview(env.DB, {
      articleId: artId,
      bodySha: "sha-2",
      decision: "approved",
      reviewer: "admin@test.com",
    });

    evRow = await env.DB.prepare("SELECT revision FROM events WHERE id = ?1")
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(1);

    // 3. Approved -> Rejected: revision 1 -> 2
    await decideReview(env.DB, {
      articleId: artId,
      bodySha: "sha-2",
      decision: "rejected",
      reviewer: "admin@test.com",
    });

    evRow = await env.DB.prepare("SELECT revision FROM events WHERE id = ?1")
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(2);

    // 4. Rejected -> Rejected again: revision stays 2
    await decideReview(env.DB, {
      articleId: artId,
      bodySha: "sha-2",
      decision: "rejected",
      reviewer: "admin@test.com",
    });

    evRow = await env.DB.prepare("SELECT revision FROM events WHERE id = ?1")
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(2);

    // 5. Rejected -> Approved: revision 2 -> 3
    await decideReview(env.DB, {
      articleId: artId,
      bodySha: "sha-2",
      decision: "approved",
      reviewer: "admin@test.com",
    });

    evRow = await env.DB.prepare("SELECT revision FROM events WHERE id = ?1")
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(3);
  });

  it("pending -> rejected does NOT bump revision", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('rev-ind-3', 'Rev 3', 'review', 100) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Src 3', 'https://e3.com/feed', 'rss', 'active', 100) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://e3.com/art3', 'https://e3.com/art3', 'Art 3', 'analyzed', 100, 'sha-3', 100)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    const artId = art!.id;

    const ev = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev 3', 0, 100, 100) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const eventId = ev!.id;

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 100)",
    )
      .bind(eventId, artId)
      .run();

    // Pending -> Rejected: revision must stay 0
    await decideReview(env.DB, {
      articleId: artId,
      bodySha: "sha-3",
      decision: "rejected",
      reviewer: "admin@test.com",
    });

    const evRow = await env.DB.prepare(
      "SELECT revision FROM events WHERE id = ?1",
    )
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(0);
  });

  it("verifies last_insert_rowid works across statements in a D1 batch", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('rowid-ind', 'Rowid', 'review', 100) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'Src', 'https://r.com/feed', 'rss', 'active', 100) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://r.com/art', 'https://r.com/art', 'Art R', 'analyzed', 100, 'sha-r', 100)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    const artId = art!.id;

    const results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO events (industry_id, title, created_at, updated_at, revision) VALUES (?1, 'New Event', 100, 100, 0)",
      ).bind(indId),
      env.DB.prepare(
        "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (last_insert_rowid(), ?1, 100)",
      ).bind(artId),
      env.DB.prepare(
        `UPDATE events SET revision = revision + 1, updated_at = 100
         WHERE id = (SELECT event_id FROM event_articles WHERE article_id = ?1)`,
      ).bind(artId),
      env.DB.prepare(
        "UPDATE articles SET stage = 'grouped', stage_updated_at = 100, requeue_count = 0 WHERE id = ?1 AND stage = 'analyzed'",
      ).bind(artId),
    ]);

    expect(results[0].meta.changes).toBe(1);
    expect(results[1].meta.changes).toBe(1);
    expect(results[3].meta.changes).toBe(1);

    const row = await env.DB.prepare(
      "SELECT ea.event_id, e.title, a.stage FROM event_articles ea JOIN events e ON e.id = ea.event_id JOIN articles a ON a.id = ea.article_id WHERE ea.article_id = ?1",
    )
      .bind(artId)
      .first<{ event_id: number; title: string; stage: string }>();

    expect(row).toBeDefined();
    expect(row?.title).toBe("New Event");
    expect(row?.stage).toBe("grouped");
  });
});
