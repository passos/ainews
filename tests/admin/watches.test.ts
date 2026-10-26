import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWatch,
  listWatches,
  listPendingWatchHits,
  listWatchHits,
  reviewWatchHit,
  updateWatch,
} from "../../src/server/admin/ops";

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM watch_hits`).run();
  await env.DB.prepare(`DELETE FROM watches`).run();
  await env.DB.prepare(`DELETE FROM events`).run();
  await env.DB.prepare(`DELETE FROM industries`).run();
});

describe("Admin Watch Operations", () => {
  it("creates, lists, updates, and inspects watch hits", async () => {
    const indRes = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, created_at)
       VALUES ('admin-tech', 'Admin Tech', 'review', 1000) RETURNING id`,
    ).first<{ id: number }>();
    const industryId = indRes!.id;

    // 1. Create watch
    const watchId = await createWatch(
      env.DB,
      {
        slug: "admin-eval-watch",
        question: "When are new evals published?",
        criteria: "Empirical evaluations only",
        keywords: ["evals", "benchmarks"],
        industryId,
        status: "active",
      },
      1000,
    );
    expect(watchId).toBeGreaterThan(0);

    // 2. List watches
    const list = await listWatches(env.DB);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(watchId);
    expect(list[0].slug).toBe("admin-eval-watch");
    expect(list[0].keywords).toEqual(["evals", "benchmarks"]);
    expect(list[0].industryName).toBe("Admin Tech");
    expect(list[0].status).toBe("active");
    expect(list[0].hitCount).toBe(0);

    // 3. Update watch status & criteria
    await updateWatch(
      env.DB,
      {
        id: watchId,
        criteria: "Updated criteria string",
        status: "paused",
      },
      2000,
    );

    const updatedList = await listWatches(env.DB);
    expect(updatedList[0].criteria).toBe("Updated criteria string");
    expect(updatedList[0].status).toBe("paused");
    expect(updatedList[0].updatedAt).toBe(2000);

    // 4. Record a hit and verify listWatchHits
    const eventRes = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (?1, 'Evaluation Milestone Event', 1, 1000, 1000) RETURNING id`,
    )
      .bind(industryId)
      .first<{ id: number }>();
    const eventId = eventRes!.id;

    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 1, 3000, 'Empirical results verified on benchmark.', '{"noul":0.99}')`,
    )
      .bind(watchId, eventId)
      .run();

    const hits = await listWatchHits(env.DB, watchId);
    expect(hits.length).toBe(1);
    expect(hits[0].eventId).toBe(eventId);
    expect(hits[0].eventTitle).toBe("Evaluation Milestone Event");
    expect(hits[0].summary).toBe("Empirical results verified on benchmark.");

    // And verify hit_count in listWatches
    const listWithHits = await listWatches(env.DB);
    expect(listWithHits[0].hitCount).toBe(1);
  });

  it("rejects watch creation and update with empty keywords", async () => {
    await expect(
      createWatch(env.DB, {
        slug: "empty-kw",
        question: "Question?",
        criteria: "Criteria",
        keywords: [],
      }),
    ).rejects.toThrow("Watch must have at least one keyword");

    await expect(
      createWatch(env.DB, {
        slug: "whitespace-kw",
        question: "Question?",
        criteria: "Criteria",
        keywords: ["   ", ""],
      }),
    ).rejects.toThrow("Watch must have at least one keyword");

    const watchId = await createWatch(env.DB, {
      slug: "valid-kw",
      question: "Question?",
      criteria: "Criteria",
      keywords: ["valid"],
    });

    await expect(
      updateWatch(env.DB, {
        id: watchId,
        keywords: [],
      }),
    ).rejects.toThrow("Watch must have at least one keyword");
  });

  it("reviewWatchHit decides a pending hit once", async () => {
    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, created_at)
       VALUES ('admin-fin', 'Admin Finance', 'review', 1000) RETURNING id`,
    ).first<{ id: number }>();
    const watchId = await createWatch(
      env.DB,
      {
        slug: "admin-review-watch",
        question: "Review question?",
        criteria: "Review criteria",
        keywords: ["review"],
      },
      1000,
    );
    const ev = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (?1, 'Review Event', 1, 1000, 1000) RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    const hit = await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
       VALUES (?1, ?2, 1, 3000, 'Pending summary.', '{}') RETURNING id`,
    )
      .bind(watchId, ev!.id)
      .first<{ id: number }>();
    const hitId = hit!.id;

    const pending = await listPendingWatchHits(env.DB);
    expect(pending.map((p) => p.id)).toEqual([hitId]);
    expect(pending[0]).toMatchObject({
      watchId,
      watchSlug: "admin-review-watch",
      eventId: ev!.id,
      eventTitle: "Review Event",
      industryName: "Admin Finance",
      industrySlug: "admin-fin",
      summary: "Pending summary.",
    });

    expect(await reviewWatchHit(env.DB, { hitId, decision: "rejected" })).toBe(
      true,
    );
    expect(await reviewWatchHit(env.DB, { hitId, decision: "approved" })).toBe(
      false,
    );

    const row = await env.DB.prepare(
      `SELECT status FROM watch_hits WHERE id = ?1`,
    )
      .bind(hitId)
      .first<{ status: string }>();
    expect(row!.status).toBe("rejected");
    expect(await listPendingWatchHits(env.DB)).toEqual([]);
    expect((await listWatchHits(env.DB, watchId))[0].status).toBe("rejected");
  });
});
