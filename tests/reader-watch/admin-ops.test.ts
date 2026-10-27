import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  listPendingWatchHits,
  listWatches,
  listWatchHits,
  reviewWatchHit,
  updateWatch,
} from "../../src/server/admin/ops";
import {
  resetPublication,
  seedEvent,
  seedSections,
} from "../publication/helpers";

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM watch_hits`).run();
  await env.DB.prepare(`DELETE FROM watches`).run();
});

async function insertReaderWatch(status: "active" | "paused"): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO watches (slug, question, criteria, keywords, status, created_at, updated_at, owner_kind, token_hash, disabled_at)
     VALUES ('r-00000000000000bb', 'Reader question text', 'Reader criteria text', '["agent"]', ?1, 100, 100, 'reader', 'hash-ops-1', ?2)
     RETURNING id`,
  )
    .bind(status, status === "paused" ? 150 : null)
    .first<{ id: number }>();
  return row!.id;
}

describe("admin watch ops handle admin watches only (#132)", () => {
  it("listWatches does not return reader watches", async () => {
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, status, created_at, updated_at)
       VALUES ('admin-watch', 'Admin question text', 'Admin criteria text', '["agent"]', 'active', 200, 200)`,
    ).run();
    const readerId = await insertReaderWatch("active");

    const list = await listWatches(env.DB);
    expect(list.map((w) => w.slug)).toEqual(["admin-watch"]);
    expect(list.map((w) => w.id)).not.toContain(readerId);
  });

  it("updateWatch does not reactivate a reader watch", async () => {
    const readerId = await insertReaderWatch("paused");

    await updateWatch(env.DB, { id: readerId, status: "active" }, 2000);

    const row = await env.DB.prepare(
      `SELECT status, updated_at FROM watches WHERE id = ?1`,
    )
      .bind(readerId)
      .first<{ status: string; updated_at: number }>();
    expect(row).toEqual({ status: "paused", updated_at: 100 });
  });
});

describe("admin watch-hit ops handle hits of admin watches only (#132)", () => {
  let industryId: number;

  beforeEach(async () => {
    await resetPublication();
    ({
      technology: { industryId },
    } = await seedSections());
  });

  async function insertAdminWatch(): Promise<number> {
    const row = await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, status, created_at, updated_at)
       VALUES ('admin-watch', 'Admin question text', 'Admin criteria text', '["agent"]', 'active', 200, 200)
       RETURNING id`,
    ).first<{ id: number }>();
    return row!.id;
  }

  /** A pending hit on an event that has an industry (the queue joins it). */
  async function insertPendingHit(watchId: number): Promise<number> {
    const eventId = await seedEvent(industryId, "Agent protocol update", 1);
    const row = await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale, status)
       VALUES (?1, ?2, 1, 300, 'What changed', '{}', 'pending_review')
       RETURNING id`,
    )
      .bind(watchId, eventId)
      .first<{ id: number }>();
    return row!.id;
  }

  async function hitStatus(hitId: number): Promise<string | undefined> {
    const row = await env.DB.prepare(
      `SELECT status FROM watch_hits WHERE id = ?1`,
    )
      .bind(hitId)
      .first<{ status: string }>();
    return row?.status;
  }

  it("listWatchHits does not return hits of a reader watch", async () => {
    const readerId = await insertReaderWatch("active");
    await insertPendingHit(readerId);

    expect(await listWatchHits(env.DB, readerId)).toEqual([]);
  });

  it("listWatchHits returns hits of an admin watch", async () => {
    const adminId = await insertAdminWatch();
    const hitId = await insertPendingHit(adminId);

    const hits = await listWatchHits(env.DB, adminId);
    expect(hits.map((h) => h.id)).toEqual([hitId]);
  });

  it("the review queue lists only hits of admin watches", async () => {
    const adminId = await insertAdminWatch();
    const adminHit = await insertPendingHit(adminId);
    const readerId = await insertReaderWatch("active");
    await insertPendingHit(readerId);

    const queue = await listPendingWatchHits(env.DB);
    expect(queue.map((h) => h.id)).toEqual([adminHit]);
  });

  it("reviewWatchHit does not decide a hit of a reader watch", async () => {
    const readerId = await insertReaderWatch("active");
    const hitId = await insertPendingHit(readerId);

    expect(await reviewWatchHit(env.DB, { hitId, decision: "approved" })).toBe(
      false,
    );
    expect(await hitStatus(hitId)).toBe("pending_review");
  });

  it("reviewWatchHit decides a hit of an admin watch", async () => {
    const adminId = await insertAdminWatch();
    const hitId = await insertPendingHit(adminId);

    expect(await reviewWatchHit(env.DB, { hitId, decision: "approved" })).toBe(
      true,
    );
    expect(await hitStatus(hitId)).toBe("published");
  });
});
