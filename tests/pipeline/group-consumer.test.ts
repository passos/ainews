import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleGroupBatch } from "../../src/pipeline/group/consumer";
import type { GroupMessage, PipelineEnv } from "../../src/pipeline/messages";
import { requeueStuck, STUCK_AFTER_MS } from "../../src/pipeline/requeue";
import type { JevAnswers, JevQuestions } from "../../src/providers/jev";
import type { ModelClient } from "../../src/providers/models";

class FakeVectorize {
  async upsert(vectors: Array<{ id: string }>) {
    return { ids: vectors.map((v) => v.id), count: vectors.length };
  }
  async query() {
    return { matches: [], count: 0 };
  }
}

function createFakeBatch(messages: GroupMessage[]): {
  batch: MessageBatch;
  acked: number[];
  retried: number[];
} {
  const acked: number[] = [];
  const retried: number[] = [];

  const msgs: Message<GroupMessage>[] = messages.map((body, idx) => ({
    id: `msg-${idx}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => {
      acked.push(body.articleId);
    },
    retry: () => {
      retried.push(body.articleId);
    },
  }));

  const batch: MessageBatch = {
    queue: "ainews-group",
    messages: msgs as unknown as Message[],
    metadata: {} as unknown as MessageBatchMetadata,
    ackAll: () => {
      for (const m of msgs) m.ack();
    },
    retryAll: () => {
      for (const m of msgs) m.retry();
    },
  };

  return { batch, acked, retried };
}

describe("handleGroupBatch consumer", () => {
  it("MODEL_CALLS_ENABLED not set: 0 model calls, stage remains analyzed, messages acked", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('c-ind-1', 'C1', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S', 'https://c1.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://c1.com/art', 'https://c1.com/art', 'Art 1', 'analyzed', 1000, 'sha-1', 1000)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    const artId = art!.id;

    let modelCallsCount = 0;
    const fakeModels = {
      embed: async () => {
        modelCallsCount++;
        return [[0.1, 0.2]];
      },
      judge: async () => {
        modelCallsCount++;
        return {} as unknown as JevAnswers<JevQuestions>;
      },
    } as unknown as ModelClient;

    const fakeVectors = new FakeVectorize();
    const { batch, acked } = createFakeBatch([
      { kind: "group", articleId: artId },
    ]);

    const pipelineEnv: PipelineEnv = {
      ...env,
      MODEL_CALLS_ENABLED: "false", // safety flag off
    };

    await handleGroupBatch(batch, pipelineEnv, {
      models: fakeModels,
      vectors: fakeVectors,
      now: () => 1000,
    });

    expect(modelCallsCount).toBe(0);
    expect(acked).toContain(artId);

    const artRow = await env.DB.prepare(
      "SELECT stage FROM articles WHERE id = ?1",
    )
      .bind(artId)
      .first<{ stage: string }>();
    expect(artRow?.stage).toBe("analyzed");
  });

  it("calls fake Jev in exact order of messages in batch", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('c-ind-2', 'C2', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S2', 'https://c2.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    // Create an existing event so Jev is invoked
    await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev Target', 0, 1000, 1000)",
    )
      .bind(indId)
      .run();

    const artIds: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const art = await env.DB.prepare(
        `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
         VALUES (?1, ?2, ?3, ?3, ?4, 'analyzed', 1000, ?5, 1000)
         RETURNING id`,
      )
        .bind(srcId, indId, `https://c2.com/art${i}`, `Art ${i}`, `sha-${i}`)
        .first<{ id: number }>();
      artIds.push(art!.id);
    }

    const orderCalled: string[] = [];
    const fakeModels = {
      embed: async () => [[0.1, 0.2]],
      judge: async (_key: string, state: unknown) => {
        const title = (state as { title: string }).title;
        orderCalled.push(title);
        return {
          event: {
            choice: "new",
            confidence: 0.9,
            probabilities: { new: 0.9 },
          },
        } as unknown as JevAnswers<JevQuestions>;
      },
    } as unknown as ModelClient;

    const fakeVectors = new FakeVectorize();
    const { batch, acked } = createFakeBatch(
      artIds.map((id) => ({ kind: "group", articleId: id })),
    );

    const pipelineEnv: PipelineEnv = {
      ...env,
      MODEL_CALLS_ENABLED: "true",
    };

    await handleGroupBatch(batch, pipelineEnv, {
      models: fakeModels,
      vectors: fakeVectors,
      now: () => 1000,
    });

    expect(acked).toEqual(artIds);
    expect(orderCalled).toEqual(["Art 1", "Art 2", "Art 3"]);
  });

  it("requeueStuck sends stuck analyzed articles to Q_GROUP", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('c-ind-3', 'C3', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S3', 'https://c3.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const now = 2_000_000;
    // Stuck article (> 30 mins)
    const artStuck = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, requeue_count, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://c3.com/stuck', 'https://c3.com/stuck', 'Stuck', 'analyzed', ?3, 0, 'sha-s', 1000)
       RETURNING id`,
    )
      .bind(srcId, indId, now - STUCK_AFTER_MS - 1000)
      .first<{ id: number }>();

    // Fresh article (< 30 mins)
    await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, requeue_count, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://c3.com/fresh', 'https://c3.com/fresh', 'Fresh', 'analyzed', ?3, 0, 'sha-f', 1000)`,
    )
      .bind(srcId, indId, now - 5000)
      .run();

    const queuedGroupMessages: GroupMessage[] = [];
    const fakeQGroup = {
      sendBatch: async (batch: { body: GroupMessage }[]) => {
        queuedGroupMessages.push(...batch.map((b) => b.body));
      },
    } as unknown as Queue;

    const pipelineEnv: PipelineEnv = {
      ...env,
      MODEL_CALLS_ENABLED: "true",
      COLLECT_ENABLED: "true",
      Q_GROUP: fakeQGroup,
    };

    const sent = await requeueStuck(pipelineEnv, now);
    expect(sent).toContain(artStuck!.id);
    expect(queuedGroupMessages).toContainEqual({
      kind: "group",
      articleId: artStuck!.id,
    });
  });
});
