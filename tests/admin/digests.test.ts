import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  approveDigestCopy,
  listAdminDigests,
  publishDigest,
} from "../../src/server/admin/ops";

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

    // 4. Query admin list again (#114): the digest is published but its model
    // copy (intro + one_liner) is not approved, so it stays in pending
    const after = await listAdminDigests(env.DB);
    expect(after.published.some((d) => d.id === digestId)).toBe(false);
    const pub = after.pending.find((d) => d.id === digestId);
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
    // #114: published, copy not approved -> still pending
    expect(afterWeekly.published.some((d) => d.id === weeklyId)).toBe(false);
    const pubWeekly = afterWeekly.pending.find((d) => d.id === weeklyId);
    expect(pubWeekly).toBeDefined();
    expect(pubWeekly!.kind).toBe("weekly");
    expect(pubWeekly!.publishedAt).toBe(4000);
  });
  // #114: non-Finance digests are published at build, so "needs the admin"
  // also covers published digests whose model copy is not approved yet.
  async function seedIndustry(slug: string): Promise<number> {
    const r = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES (?1, ?1, 'review', 0) RETURNING id",
    )
      .bind(slug)
      .first<{ id: number }>();
    return r!.id;
  }

  async function seedReadyDigest(
    indId: number,
    o: { intro: string; oneLiner: string | null; publishedAt: number | null },
  ): Promise<number> {
    const itemsJson = JSON.stringify([
      {
        eventId: 114,
        title: "Copy Story 114",
        summary: "Article summary 114",
        oneLiner: o.oneLiner,
        sourceName: "Wire",
        articleCount: 1,
      },
    ]);
    const r = await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-25', 'UTC', 'ready', ?2, ?3, 1000, ?4) RETURNING id`,
    )
      .bind(indId, o.intro, itemsJson, o.publishedAt)
      .first<{ id: number }>();
    return r!.id;
  }

  it("published digest with unapproved model copy is listed as pending", async () => {
    const indId = await seedIndustry("admin-114-witness");
    const id = await seedReadyDigest(indId, {
      intro: "MODEL INTRO 114",
      oneLiner: "MODEL LINER 114",
      publishedAt: 1000,
    });

    const list = await listAdminDigests(env.DB);
    expect(list.pending.some((d) => d.id === id)).toBe(true);
    expect(list.published.some((d) => d.id === id)).toBe(false);
  });

  it("published digest without model copy is listed as published", async () => {
    const indId = await seedIndustry("admin-114-nocopy");
    const id = await seedReadyDigest(indId, {
      intro: "",
      oneLiner: null,
      publishedAt: 1000,
    });

    const list = await listAdminDigests(env.DB);
    expect(list.published.some((d) => d.id === id)).toBe(true);
    expect(list.pending.some((d) => d.id === id)).toBe(false);
  });

  it("approveDigestCopy approves once", async () => {
    const indId = await seedIndustry("admin-114-approve");
    const id = await seedReadyDigest(indId, {
      intro: "MODEL INTRO 114",
      oneLiner: "MODEL LINER 114",
      publishedAt: 1000,
    });

    const before = await listAdminDigests(env.DB);
    const pendingRow = before.pending.find((d) => d.id === id);
    expect(pendingRow).toBeDefined();
    expect(pendingRow!.hasCopy).toBe(true);
    expect(pendingRow!.copyApprovedAt).toBeNull();
    expect(before.published.some((d) => d.id === id)).toBe(false);

    expect(await approveDigestCopy(env.DB, id, 5000)).toBe(true);
    expect(await approveDigestCopy(env.DB, id, 6000)).toBe(false);
    const col = await env.DB.prepare(
      "SELECT copy_approved_at FROM digests WHERE id = ?1",
    )
      .bind(id)
      .first<{ copy_approved_at: number | null }>();
    expect(col!.copy_approved_at).toBe(5000);

    const after = await listAdminDigests(env.DB);
    expect(after.pending.some((d) => d.id === id)).toBe(false);
    const pubRow = after.published.find((d) => d.id === id);
    expect(pubRow).toBeDefined();
    expect(pubRow!.copyApprovedAt).toBe(5000);
    expect(pubRow!.hasCopy).toBe(true);
  });

  it("approveDigestCopy refuses an empty digest", async () => {
    const indId = await seedIndustry("admin-114-empty");
    const r = await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-25', 'UTC', 'empty', '', '[]', 1000, NULL) RETURNING id`,
    )
      .bind(indId)
      .first<{ id: number }>();

    expect(await approveDigestCopy(env.DB, r!.id, 5000)).toBe(false);
    const col = await env.DB.prepare(
      "SELECT copy_approved_at FROM digests WHERE id = ?1",
    )
      .bind(r!.id)
      .first<{ copy_approved_at: number | null }>();
    expect(col!.copy_approved_at).toBeNull();
  });
});
