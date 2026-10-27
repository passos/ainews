import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { listWatches, updateWatch } from "../../src/server/admin/ops";

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
