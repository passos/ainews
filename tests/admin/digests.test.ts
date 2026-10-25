import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listAdminDigests, publishDigest } from "../../src/server/admin/ops";

describe("admin digests operations", () => {
  it("lists pending and published digests; publishDigest updates published_at atomically", async () => {
    const indRes = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('admin-dig-ind', 'Admin Dig Ind', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const indId = indRes!.id;

    // 1. Insert unpublished digest with items preview
    const itemsJson = JSON.stringify([
      {
        eventId: 42,
        title: "Preview Story Title",
        oneLiner: "Key reason why this story matters.",
        sourceName: "Finance Wire",
        articleCount: 2,
      },
    ]);
    const ins = await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', 'Intro text', ?2, 1000, NULL) RETURNING id`,
    )
      .bind(indId, itemsJson)
      .first<{ id: number }>();
    const digestId = ins!.id;

    // 2. Query admin list: pending has digestId with full item preview, published does not
    const before = await listAdminDigests(env.DB);
    const pendingItem = before.pending.find((d) => d.id === digestId);
    expect(pendingItem).toBeDefined();
    expect(pendingItem!.kind).toBe("daily");
    expect(pendingItem!.items).toHaveLength(1);
    expect(pendingItem!.items[0].title).toBe("Preview Story Title");
    expect(pendingItem!.items[0].oneLiner).toBe(
      "Key reason why this story matters.",
    );
    expect(pendingItem!.items[0].sourceName).toBe("Finance Wire");
    expect(before.published.some((d) => d.id === digestId)).toBe(false);

    // 3. Publish digest
    const now = 2000;
    const ok = await publishDigest(env.DB, digestId, now);
    expect(ok).toBe(true);

    // 4. Query admin list again: pending does not have digestId, published has it
    const after = await listAdminDigests(env.DB);
    expect(after.pending.some((d) => d.id === digestId)).toBe(false);
    const pub = after.published.find((d) => d.id === digestId);
    expect(pub).toBeDefined();
    expect(pub!.kind).toBe("daily");
    expect(pub!.publishedAt).toBe(now);

    // 5. Repeated publish returns false (idempotent guard)
    const secondOk = await publishDigest(env.DB, digestId, now);
    expect(secondOk).toBe(false);

    // 6. Weekly digest in admin list
    const insWeekly = await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'weekly', '2026-10-19', 'UTC', 'ready', 'Weekly overview', ?2, 3000, NULL) RETURNING id`,
    )
      .bind(indId, itemsJson)
      .first<{ id: number }>();
    const weeklyId = insWeekly!.id;

    const weeklyList = await listAdminDigests(env.DB);
    const pendingWeekly = weeklyList.pending.find((d) => d.id === weeklyId);
    expect(pendingWeekly).toBeDefined();
    expect(pendingWeekly!.kind).toBe("weekly");
    expect(pendingWeekly!.periodStart).toBe("2026-10-19");

    const weeklyPublished = await publishDigest(env.DB, weeklyId, 4000);
    expect(weeklyPublished).toBe(true);
    const afterWeekly = await listAdminDigests(env.DB);
    const pubWeekly = afterWeekly.published.find((d) => d.id === weeklyId);
    expect(pubWeekly).toBeDefined();
    expect(pubWeekly!.kind).toBe("weekly");
    expect(pubWeekly!.publishedAt).toBe(4000);
  });
});
