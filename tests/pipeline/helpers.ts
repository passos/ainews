// Shared setup for pipeline tests. No test reaches a real service: fetches go
// to `fakeFetch` (tests/providers/fakes.ts) and messages to `fakeQueue`.
import { env } from "cloudflare:workers";
import type { IngestMessage, PipelineEnv } from "../../src/pipeline/messages";

export { fakeFetch, NOW } from "../providers/fakes";

export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;

export interface FakeQueue {
  queue: Queue;
  sent: IngestMessage[];
  /** sendBatch calls. */
  batches: number;
}

/** `onBatch` runs before each sendBatch is recorded, e.g. to check R2. */
export function fakeQueue(
  onBatch?: (bodies: IngestMessage[]) => Promise<void>,
): FakeQueue {
  const fake: FakeQueue = { sent: [], batches: 0, queue: undefined as never };
  fake.queue = {
    async send(body: IngestMessage) {
      fake.sent.push(body);
    },
    async sendBatch(messages: Iterable<MessageSendRequest<IngestMessage>>) {
      fake.batches += 1;
      const bodies = [...messages].map((m) => m.body);
      await onBatch?.(bodies);
      fake.sent.push(...bodies);
    },
  } as unknown as Queue;
  return fake;
}

/** The test env with a fake Q_INGEST. Flags are off unless given. */
export function pipelineEnv(
  q: FakeQueue,
  flags: { COLLECT_ENABLED?: string; MODEL_CALLS_ENABLED?: string } = {},
): PipelineEnv {
  return { DB: env.DB, BODIES: env.BODIES, Q_INGEST: q.queue, ...flags };
}

export const ON = { COLLECT_ENABLED: "true" };

/** Storage is shared by the tests of a file: start each test empty. */
export async function resetPipeline(): Promise<void> {
  const { objects } = await env.BODIES.list({ prefix: "feed/" });
  if (objects.length > 0) await env.BODIES.delete(objects.map((o) => o.key));
  await env.DB.batch(
    ["article_sightings", "articles", "sources", "industries"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}

export async function seedIndustry(slug: string): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO industries (slug, name, created_at) VALUES (?1, ?1, 0) RETURNING id",
  )
    .bind(slug)
    .first<{ id: number }>();
  return row!.id;
}

export interface SourceSeed {
  industryId: number;
  feedUrl: string;
  kind?: "rss" | "html";
  status?: string;
  config?: unknown;
  utcOffset?: string;
  nextFetchAt?: number;
  createdAt?: number;
  lastOkAt?: number | null;
  failCount?: number;
  etag?: string | null;
  intervalMinutes?: number;
  emptyFetches?: number;
}

export async function seedSource(s: SourceSeed): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO sources (industry_id, feed_url, kind, status, config,
       utc_offset, next_fetch_at, created_at, last_ok_at, fail_count, etag,
       interval_minutes, empty_fetches)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     RETURNING id`,
  )
    .bind(
      s.industryId,
      s.feedUrl,
      s.kind ?? "rss",
      s.status ?? "active",
      JSON.stringify(s.config ?? {}),
      s.utcOffset ?? "+00:00",
      s.nextFetchAt ?? 0,
      s.createdAt ?? 0,
      s.lastOkAt ?? null,
      s.failCount ?? 0,
      s.etag ?? null,
      s.intervalMinutes ?? 60,
      s.emptyFetches ?? 0,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function sourceRow(id: number) {
  return env.DB.prepare(
    `SELECT status, paused_reason, fail_count, last_ok_at, last_failed_at,
       last_error, etag, last_modified, next_fetch_at, empty_fetches
     FROM sources WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      status: string;
      paused_reason: string | null;
      fail_count: number;
      last_ok_at: number | null;
      last_failed_at: number | null;
      last_error: string | null;
      etag: string | null;
      last_modified: string | null;
      next_fetch_at: number;
      empty_fetches: number;
    }>();
}

export async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row!.n;
}

export interface ArticleSeed {
  sourceId: number;
  industryId: number;
  url: string;
  stage?: string;
  stageUpdatedAt: number;
  requeueCount?: number;
}

export async function seedArticle(a: ArticleSeed): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title,
       fetched_at, stage, stage_updated_at, requeue_count)
     VALUES (?1, ?2, ?3, ?3, 't', 0, ?4, ?5, ?6) RETURNING id`,
  )
    .bind(
      a.sourceId,
      a.industryId,
      a.url,
      a.stage ?? "collected",
      a.stageUpdatedAt,
      a.requeueCount ?? 0,
    )
    .first<{ id: number }>();
  return row!.id;
}
