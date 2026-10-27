import { env } from "cloudflare:workers";
// The Worker entry points: queue() and scheduled() in src/server.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestMessage } from "../../src/pipeline/messages";
import { runQueue } from "../../src/pipeline/queue";
import { runScheduled } from "../../src/pipeline/scheduled";
import arxivXml from "../fixtures/feeds/arxiv-cs-ai.xml?raw";
import {
  count,
  DAY,
  fakeFetch,
  fakeQueue,
  MIN,
  NOW,
  ON,
  pipelineEnv,
  resetPipeline,
  seedArticle,
  seedIndustry,
  seedSource,
  sourceRow,
} from "./helpers";

const ctx = {} as ExecutionContext;

function batch(queue: string, bodies: IngestMessage[]) {
  const acked: number[] = [];
  const b = {
    queue,
    messages: bodies.map((body, i) => ({
      id: String(i),
      timestamp: new Date(NOW),
      attempts: 1,
      body,
      ack: () => acked.push(i),
      retry: () => {},
    })),
    ackAll: () => bodies.forEach((_, i) => acked.push(i)),
    retryAll: () => {},
  };
  return { batch: b as unknown as MessageBatch, acked };
}

const controller = (scheduledTime: number) =>
  ({
    cron: "*/10 * * * *",
    scheduledTime,
    noRetry() {},
  }) as ScheduledController;

let industry: number;
let source: number;
beforeEach(async () => {
  await resetPipeline();
  industry = await seedIndustry("ai");
  source = await seedSource({
    industryId: industry,
    feedUrl: "https://rss.arxiv.org/rss/cs.AI",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("runQueue", () => {
  it("processes the same collect message twice: one row per article, body sent once", async () => {
    const q = fakeQueue();
    const f = fakeFetch(() => new Response(arxivXml));
    const msg: IngestMessage = { kind: "collect", sourceId: source };
    const { batch: b, acked } = batch("ainews-ingest", [msg, msg]);
    await runQueue(b, pipelineEnv(q, ON), ctx, f);
    expect(f.requests).toHaveLength(2);
    expect(acked).toEqual([0, 1]);
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(20);
    expect(await count("SELECT count(*) AS n FROM article_sightings")).toBe(20);
    // The second run succeeded too; it found nothing new.
    expect(await sourceRow(source)).toMatchObject({
      fail_count: 0,
      last_error: null,
    });
    expect(q.sent).toHaveLength(20);
    expect(
      new Set(q.sent.map((m) => (m.kind === "body" ? m.articleId : -1))).size,
    ).toBe(20);
  });

  it("acks a failing collect instead of throwing", async () => {
    const { batch: b, acked } = batch("ainews-ingest", [
      { kind: "collect", sourceId: source },
    ]);
    await runQueue(
      b,
      pipelineEnv(fakeQueue(), ON),
      ctx,
      fakeFetch(() => new Response("", { status: 500 })),
    );
    expect(acked).toEqual([0]);
    expect((await sourceRow(source))?.fail_count).toBe(1);
  });

  it("acks other queues, and ingest messages whose flag is off", async () => {
    const other = batch("ainews-group", [{ kind: "body", articleId: 1 }]);
    await runQueue(other.batch, pipelineEnv(fakeQueue(), ON), ctx);
    expect(other.acked).toEqual([0]);
    const later = batch("ainews-ingest", [
      { kind: "body", articleId: 1 },
      { kind: "analyze", articleId: 1 },
    ]);
    await runQueue(later.batch, pipelineEnv(fakeQueue(), ON), ctx);
    expect(later.acked).toEqual([0, 1]);
  });
});

describe("COLLECT_ENABLED not set", () => {
  it("scheduled() and a queued collect message make no request and send no message", async () => {
    const real = vi.spyOn(globalThis, "fetch");
    await seedArticle({
      sourceId: source,
      industryId: industry,
      url: "https://x/1",
      stageUpdatedAt: NOW - 31 * MIN,
    });
    const q = fakeQueue();
    const e = pipelineEnv(q);
    expect(e.COLLECT_ENABLED).toBeUndefined();
    // A source that one more empty fetch would pause: the cron leaves every
    // source row as it is.
    await seedSource({
      industryId: industry,
      feedUrl: "https://stale.example/feed",
      createdAt: NOW - 400 * DAY,
      lastOkAt: NOW - 31 * DAY,
      emptyFetches: 10_000,
    });
    const before = await env.DB.prepare(
      "SELECT * FROM sources ORDER BY id",
    ).all();
    await runScheduled(controller(NOW), e, ctx);
    expect(
      (await env.DB.prepare("SELECT * FROM sources ORDER BY id").all()).results,
    ).toEqual(before.results);
    const f = fakeFetch(() => new Response(arxivXml));
    const msg = batch("ainews-ingest", [{ kind: "collect", sourceId: source }]);
    await runQueue(msg.batch, e, ctx, f);
    // Default deps too: real fetch is never called.
    await runQueue(
      batch("ainews-ingest", [{ kind: "collect", sourceId: source }]).batch,
      e,
      ctx,
    );
    expect(f.requests).toHaveLength(0);
    expect(real).not.toHaveBeenCalled();
    expect(q.sent).toHaveLength(0);
    expect(msg.acked).toEqual([0]);
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(1);
    expect((await sourceRow(source))?.next_fetch_at).toBe(0);
  });
});

describe("runScheduled", () => {
  it("claims due sources and requeues stuck rows", async () => {
    const stuck = await seedArticle({
      sourceId: source,
      industryId: industry,
      url: "https://x/1",
      stageUpdatedAt: NOW - 31 * MIN,
    });
    const q = fakeQueue();
    await runScheduled(controller(NOW), pipelineEnv(q, ON), ctx);
    expect(q.sent).toEqual([
      { kind: "collect", sourceId: source },
      { kind: "body", articleId: stuck },
    ]);
  });

  it("pauses a reader watch never read for more than 3 days (#132 sweep)", async () => {
    const slug = `r-entry-${Math.random().toString(16).slice(2)}`;
    const id = (await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at, owner_kind, token_hash)
       VALUES (?1, 'Q?', 'C', '["x"]', NULL, 'active', ?2, ?2, 'reader', ?3) RETURNING id`,
    )
      .bind(slug, NOW - 3 * DAY - MIN, `hash-${slug}`)
      .first<{ id: number }>())!.id;

    await runScheduled(controller(NOW), pipelineEnv(fakeQueue(), ON), ctx);

    expect(
      await env.DB.prepare(
        `SELECT status, disabled_at FROM watches WHERE id = ?1`,
      )
        .bind(id)
        .first(),
    ).toEqual({ status: "paused", disabled_at: NOW });
  });
});
