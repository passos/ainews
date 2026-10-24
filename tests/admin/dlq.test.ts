import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { persistDeadLetters } from "../../src/pipeline/dlq";
import { db } from "../pipeline/helpers";

describe("DLQ message persistence", () => {
  it("persists messages to dlq_messages table and acks them", async () => {
    const database = db();
    const acked: string[] = [];
    const messages = [
      {
        id: "msg-1",
        attempts: 3,
        body: { kind: "group", articleId: 10 },
        timestamp: new Date(),
        ack: () => {
          acked.push("msg-1");
        },
        retry: () => {},
      },
      {
        id: "msg-2",
        attempts: 1,
        body: { kind: "collect", sourceId: 1 },
        timestamp: new Date(),
        ack: () => {
          acked.push("msg-2");
        },
        retry: () => {},
      },
    ] as unknown as readonly Message<unknown>[];

    const batch = {
      queue: "ainews-dlq",
      messages,
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch;

    await persistDeadLetters(batch, { DB: database } as any);

    expect(acked).toEqual(["msg-1", "msg-2"]);

    const rows = await database.all<{
      id: string;
      kind: string;
      body_json: string;
      attempts: number;
      replayed_at: number | null;
    }>(sql`SELECT id, kind, body_json, attempts, replayed_at FROM dlq_messages ORDER BY id ASC`);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "msg-1",
      kind: "group",
      attempts: 3,
      replayed_at: null,
    });
    expect(JSON.parse(rows[0].body_json)).toEqual({ kind: "group", articleId: 10 });
    expect(rows[1]).toMatchObject({
      id: "msg-2",
      kind: "collect",
      attempts: 1,
      replayed_at: null,
    });
  });
});

describe("corrections index query plan", () => {
  it("uses corrections_target_idx without temp b-tree", async () => {
    const database = db();
    const plan = await database.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT body FROM corrections
      WHERE target_type = 'article' AND target_id = 1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    const details = plan.map((r) => r.detail).join("\n");
    expect(details).toContain("USING INDEX corrections_target_idx");
    expect(details).not.toContain("TEMP B-TREE");
  });
});
