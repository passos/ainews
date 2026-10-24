import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listAdminDigests, publishDigest } from "../../src/server/admin/ops";

describe("admin digests operations", () => {
  it("lists pending and published digests; publishDigest updates published_at atomically", async () => {
    const indRes = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('admin-dig-ind', 'Admin Dig Ind', 'review', 0) RETURNING id",
    ).first<{ id: number }>();
    const indId = indRes!.id;

    // 1. Insert unpublished digest
    const ins = await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', 'Intro text', '[]', 1000, NULL) RETURNING id`,
    )
      .bind(indId)
      .first<{ id: number }>();
    const digestId = ins!.id;

    // 2. Query admin list: pending has digestId, published does not
    const before = await listAdminDigests(env.DB);
    expect(before.pending.some((d) => d.id === digestId)).toBe(true);
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
    expect(pub!.publishedAt).toBe(now);

    // 5. Repeated publish returns false (idempotent guard)
    const secondOk = await publishDigest(env.DB, digestId, now);
    expect(secondOk).toBe(false);
  });
});
