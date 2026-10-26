import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleGroupBatch } from "../../src/pipeline/group/consumer";
import type {
  GenerateMessage,
  GroupMessage,
  PipelineEnv,
} from "../../src/pipeline/messages";
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

function createRecordingQGenerate(): { queue: Queue; sent: GenerateMessage[] } {
  const sent: GenerateMessage[] = [];
  const queue = {
    sendBatch: async (b: { body: GenerateMessage }[]) => {
      sent.push(...b.map((x) => x.body));
    },
  } as unknown as Queue;
  return { queue, sent };
}

async function seedRedeliveryArticle(
  slug: string,
  host: string,
  bodySha: string,
  approved: boolean,
): Promise<{ indId: number; artId: number }> {
  const ind = await env.DB.prepare(
    "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES (?1, ?1, 'review', 1000) RETURNING id",
  )
    .bind(slug)
    .first<{ id: number }>();
  const indId = ind!.id;

  const src = await env.DB.prepare(
    "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, ?2, ?3, 'rss', 'active', 1000) RETURNING id",
  )
    .bind(indId, `S ${slug}`, `https://${host}/rss`)
    .first<{ id: number }>();

  const art = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
     VALUES (?1, ?2, ?3, ?3, ?4, 'analyzed', 1000, ?5, 1000)
     RETURNING id`,
  )
    .bind(src!.id, indId, `https://${host}/art`, `Art ${slug}`, bodySha)
    .first<{ id: number }>();
  const artId = art!.id;

  if (approved) {
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, ?2, 'approved', 'human', 1000)",
    )
      .bind(artId, bodySha)
      .run();
  }
  return { indId, artId };
}

async function eventOf(artId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT event_id FROM event_articles WHERE article_id = ?1",
  )
    .bind(artId)
    .first<{ event_id: number }>();
  return row!.event_id;
}

async function eventRow(
  eventId: number,
): Promise<{ revision: number; updated_at: number }> {
  const row = await env.DB.prepare(
    "SELECT revision, updated_at FROM events WHERE id = ?1",
  )
    .bind(eventId)
    .first<{ revision: number; updated_at: number }>();
  return row!;
}

const noJudgeModels = {
  embed: async () => [[0.1, 0.2]],
  judge: async () => {
    throw new Error("judge must not be called: no candidate events");
  },
} as unknown as ModelClient;

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

  it("redelivery via handleGroupBatch (approved article): revision stays 1 and no new generate messages", async () => {
    const { artId } = await seedRedeliveryArticle(
      "c-ind-redeliver-a",
      "redeliver-a.test",
      "sha-ra",
      true,
    );
    const { queue, sent } = createRecordingQGenerate();
    const pipelineEnv: PipelineEnv = {
      ...env,
      MODEL_CALLS_ENABLED: "true",
      Q_GENERATE: queue,
    };
    const vectors = new FakeVectorize();

    const first = createFakeBatch([{ kind: "group", articleId: artId }]);
    await handleGroupBatch(first.batch, pipelineEnv, {
      models: noJudgeModels,
      vectors,
      now: () => 1000,
    });
    const eventId = await eventOf(artId);
    expect(sent).toEqual([
      { kind: "artifacts", eventId },
      { kind: "evidence", eventId },
      { kind: "watch", eventId },
    ]);
    expect((await eventRow(eventId)).revision).toBe(1);

    const second = createFakeBatch([{ kind: "group", articleId: artId }]);
    await handleGroupBatch(second.batch, pipelineEnv, {
      models: noJudgeModels,
      vectors,
      now: () => 2000,
    });
    const after = await eventRow(eventId);
    expect(after.revision).toBe(1);
    expect(after.updated_at).toBe(1000);
    expect(sent.length).toBe(3);
    expect(second.acked).toEqual([artId]);
    expect(second.retried).toEqual([]);
  });

  it("redelivery via handleGroupBatch (pending article): revision stays 0 and no new generate messages", async () => {
    const { artId } = await seedRedeliveryArticle(
      "c-ind-redeliver-p",
      "redeliver-p.test",
      "sha-rp",
      false,
    );
    const { queue, sent } = createRecordingQGenerate();
    const pipelineEnv: PipelineEnv = {
      ...env,
      MODEL_CALLS_ENABLED: "true",
      Q_GENERATE: queue,
    };
    const vectors = new FakeVectorize();

    const first = createFakeBatch([{ kind: "group", articleId: artId }]);
    await handleGroupBatch(first.batch, pipelineEnv, {
      models: noJudgeModels,
      vectors,
      now: () => 1000,
    });
    const eventId = await eventOf(artId);
    expect((await eventRow(eventId)).revision).toBe(0);
    expect(sent.length).toBe(3);

    const second = createFakeBatch([{ kind: "group", articleId: artId }]);
    await handleGroupBatch(second.batch, pipelineEnv, {
      models: noJudgeModels,
      vectors,
      now: () => 2000,
    });
    expect((await eventRow(eventId)).revision).toBe(0);
    expect(sent.length).toBe(3);
    expect(second.acked).toEqual([artId]);
    expect(second.retried).toEqual([]);
  });

  it("article linked concurrently during grouping: already_grouped does not bump the linked event again", async () => {
    const { indId, artId } = await seedRedeliveryArticle(
      "c-ind-race",
      "race.test",
      "sha-race",
      true,
    );
    // Event X: created inside the recent window, so it becomes a candidate.
    const x = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev X', 0, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const xId = x!.id;

    let judgeCalls = 0;
    const racingModels = {
      // Simulates primary.ts linking the same approved article into X
      // while groupArticle waits for the embedding.
      embed: async () => {
        await env.DB.prepare(
          "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
        )
          .bind(xId, artId)
          .run();
        await env.DB.prepare(
          "UPDATE articles SET stage = 'grouped' WHERE id = ?1",
        )
          .bind(artId)
          .run();
        await env.DB.prepare(
          "UPDATE events SET revision = revision + 1 WHERE id = ?1",
        )
          .bind(xId)
          .run();
        return [[0.1, 0.2]];
      },
      judge: async () => {
        judgeCalls++;
        return {
          event: {
            choice: "new",
            confidence: 0.9,
            probabilities: { new: 0.9 },
          },
        } as unknown as JevAnswers<JevQuestions>;
      },
    } as unknown as ModelClient;

    const { queue, sent } = createRecordingQGenerate();
    const pipelineEnv: PipelineEnv = {
      ...env,
      MODEL_CALLS_ENABLED: "true",
      Q_GENERATE: queue,
    };

    const { batch, acked } = createFakeBatch([
      { kind: "group", articleId: artId },
    ]);
    await handleGroupBatch(batch, pipelineEnv, {
      models: racingModels,
      vectors: new FakeVectorize(),
      now: () => 1000,
    });

    expect(judgeCalls).toBe(1);
    expect((await eventRow(xId)).revision).toBe(1);
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM events WHERE industry_id = ?1",
    )
      .bind(indId)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
    expect(sent.length).toBe(0);
    expect(acked).toEqual([artId]);
  });

  it("merge branch: article linked concurrently into another event does not bump the judge-chosen event", async () => {
    // Guards `changes() = 1` in the merge branch's revision bump (#92): when
    // the event_articles insert writes 0 rows, the article belongs to another
    // event and the chosen event must keep its revision.
    const { indId, artId } = await seedRedeliveryArticle(
      "c-ind-race-merge",
      "race-merge.test",
      "sha-race-m",
      true,
    );
    const x = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev Merge X', 0, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const xId = x!.id;
    const y = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev Merge Y', 0, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const yId = y!.id;

    const judgeOptions: string[][] = [];
    const racingModels = {
      // Simulates another writer linking the same approved article into Y
      // while groupArticle waits for the embedding.
      embed: async () => {
        await env.DB.prepare(
          "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
        )
          .bind(yId, artId)
          .run();
        await env.DB.prepare(
          "UPDATE articles SET stage = 'grouped' WHERE id = ?1",
        )
          .bind(artId)
          .run();
        await env.DB.prepare(
          "UPDATE events SET revision = revision + 1 WHERE id = ?1",
        )
          .bind(yId)
          .run();
        return [[0.1, 0.2]];
      },
      judge: async (
        _key: string,
        _state: unknown,
        questions: { event: { criteria: Record<string, string> } },
      ) => {
        judgeOptions.push(Object.keys(questions.event.criteria));
        return {
          event: {
            choice: `event_${xId}`,
            confidence: 0.9,
            probabilities: { [`event_${xId}`]: 0.9 },
          },
        } as unknown as JevAnswers<JevQuestions>;
      },
    } as unknown as ModelClient;

    const { queue, sent } = createRecordingQGenerate();
    const pipelineEnv: PipelineEnv = {
      ...env,
      MODEL_CALLS_ENABLED: "true",
      Q_GENERATE: queue,
    };

    const { batch, acked } = createFakeBatch([
      { kind: "group", articleId: artId },
    ]);
    await handleGroupBatch(batch, pipelineEnv, {
      models: racingModels,
      vectors: new FakeVectorize(),
      now: () => 1000,
    });

    // The judge was offered X, so the merge branch targeted X.
    expect(judgeOptions).toHaveLength(1);
    expect(judgeOptions[0]).toContain(`event_${xId}`);
    expect((await eventRow(xId)).revision).toBe(0);
    expect((await eventRow(yId)).revision).toBe(1);
    expect(await eventOf(artId)).toBe(yId);
    expect(sent.length).toBe(0);
    expect(acked).toEqual([artId]);
  });
});
