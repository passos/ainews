import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildDailyDigest } from "../../src/pipeline/digest/build";
import { sendDigestEmail } from "../../src/pipeline/digest/email";
import { enqueueDueDigests } from "../../src/pipeline/digest/schedule";
import { handleGenerateBatch } from "../../src/pipeline/generate/consumer";
import type { DigestMessage, PipelineEnv } from "../../src/pipeline/messages";
import { CallInProgressError } from "../../src/providers/models";
import type { ModelTransport } from "../../src/providers/transport";

class FakeQueue {
  sent: DigestMessage[] = [];
  async send(msg: DigestMessage) {
    this.sent.push(msg);
  }
  async sendBatch(msgs: Iterable<{ body: DigestMessage }>) {
    this.sent.push(...Array.from(msgs).map((m) => m.body));
  }
}

class FakeEmail {
  sent: unknown[] = [];
  shouldFail = false;
  async send(msg: unknown) {
    if (this.shouldFail) {
      throw new Error("Failed to deliver email");
    }
    this.sent.push(msg);
  }
}

describe("enqueueDueDigests", () => {
  it("enqueues due digests for industries without a digest for target date", async () => {
    const queue = new FakeQueue();
    // 2026-10-22 10:00:00 UTC -> yesterday is 2026-10-21
    const now = Date.parse("2026-10-22T10:00:00.000Z");

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('sched-test', 'Sched Test', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();

    const pipelineEnv: Pick<PipelineEnv, "DB" | "Q_GENERATE"> = {
      DB: env.DB,
      Q_GENERATE: queue as unknown as Queue,
    };

    const messages = await enqueueDueDigests(pipelineEnv, now);
    expect(
      messages.some(
        (m) => m.industryId === ind!.id && m.periodStart === "2026-10-21",
      ),
    ).toBe(true);
    expect(
      queue.sent.some(
        (m) => m.industryId === ind!.id && m.periodStart === "2026-10-21",
      ),
    ).toBe(true);

    // If a digest row already exists for target date, it should not enqueue again
    await env.DB.prepare(
      "INSERT INTO digests (industry_id, kind, period_start, timezone, status, created_at) VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', ?2)",
    )
      .bind(ind!.id, now)
      .run();

    const secondRun = await enqueueDueDigests(pipelineEnv, now);
    expect(secondRun.some((m) => m.industryId === ind!.id)).toBe(false);
  });
});

describe("buildDailyDigest", () => {
  it("when 0 events match window: status = 'empty', does not call model, does not email", async () => {
    const fakeEmail = new FakeEmail();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('empty-ind', 'Empty Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();

    let modelCalled = false;
    const transport: ModelTransport = {
      run: async () => {
        modelCalled = true;
        return { text: "{}", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "true",
    };

    const msg: DigestMessage = {
      kind: "digest",
      industryId: ind!.id,
      digestKind: "daily",
      periodStart: "2026-10-20",
    };

    await buildDailyDigest(
      pipelineEnv,
      msg,
      Date.parse("2026-10-21T01:00:00Z"),
      { transport },
    );

    expect(modelCalled).toBe(false);
    expect(fakeEmail.sent).toHaveLength(0);

    const row = await env.DB.prepare(
      "SELECT status, intro, items_json FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-20'",
    )
      .bind(ind!.id)
      .first<{ status: string; intro: string; items_json: string }>();

    expect(row).toBeDefined();
    expect(row!.status).toBe("empty");
    expect(row!.intro).toBe("");
    expect(row!.items_json).toBe("[]");
  });

  it("same message delivered 3 times: 1 row in digests, write called once, email called once", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('repeat-ind', 'Repeat Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src', 'http://a/feed', 'a.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://a.com/repeat-1', 'http://a.com/repeat-1', 'Repeat Story', 'Summary 1', 'grouped', 'sha1', 1729468800000, 1729468800000, 1729468800000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event 1', 1, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    // Approved on 2026-10-21 (UTC 1729500000000 = 2026-10-21 08:40:00 UTC)
    const reviewTime = Date.parse("2026-10-21T08:40:00Z");
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha1', 'approved', 'auto', ?2)",
    )
      .bind(art!.id, reviewTime)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, created_at, selected, title_en, summary_en)
       VALUES (?1, 'v1', '{}', 'report', '{}', 85, ?2, 1, 'Written Title', 'Written Summary')`,
    )
      .bind(art!.id, reviewTime)
      .run();

    let writeCallCount = 0;
    const transport: ModelTransport = {
      run: async () => {
        writeCallCount++;
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      intro: "Editor summary of the day.",
                      items: [
                        {
                          event_id: event!.id,
                          one_liner: "Key milestone achieved.",
                        },
                      ],
                    }),
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20 },
        };
      },
    };

    const fakeEmail = new FakeEmail();
    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "true",
    };

    const msg: DigestMessage = {
      kind: "digest",
      industryId: indId,
      digestKind: "daily",
      periodStart: "2026-10-21",
    };

    // Deliver 3 times
    const now = Date.parse("2026-10-22T02:00:00Z");
    await buildDailyDigest(pipelineEnv, msg, now, { transport });
    await buildDailyDigest(pipelineEnv, msg, now, { transport });
    await buildDailyDigest(pipelineEnv, msg, now, { transport });

    // Verify 1 row in digests
    const { results: digestRows } = await env.DB.prepare(
      "SELECT id, intro, items_json, status, published_at, emailed_at FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-21'",
    )
      .bind(indId)
      .all<{
        id: number;
        intro: string;
        items_json: string;
        status: string;
        published_at: number;
        emailed_at: number;
      }>();

    expect(digestRows).toHaveLength(1);
    expect(digestRows[0].status).toBe("ready");
    expect(digestRows[0].intro).toBe("Editor summary of the day.");
    // Auto industry -> published_at set
    expect(digestRows[0].published_at).toBe(now);
    // Write was called only once (ledger idempotency on logical_key)
    expect(writeCallCount).toBe(1);
    // Email was sent only once
    expect(fakeEmail.sent).toHaveLength(1);
    expect(digestRows[0].emailed_at).toBe(now);
  });

  it("EMAIL_ENABLED off: does not claim and does not send email", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('no-email-ind', 'No Email Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src', 'http://b/feed', 'b.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://b.com/1', 'http://b.com/1', 'Story B', 'Summary B', 'grouped', 'shaB', 1729468800000, 1729468800000, 1729468800000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event B', 1, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaB', 'approved', 'auto', ?2)",
    )
      .bind(art!.id, Date.parse("2026-10-21T05:00:00Z"))
      .run();

    const fakeEmail = new FakeEmail();
    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "false",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "false",
    };

    const msg: DigestMessage = {
      kind: "digest",
      industryId: indId,
      digestKind: "daily",
      periodStart: "2026-10-21",
    };

    await buildDailyDigest(
      pipelineEnv,
      msg,
      Date.parse("2026-10-22T01:00:00Z"),
    );

    expect(fakeEmail.sent).toHaveLength(0);
    const row = await env.DB.prepare(
      "SELECT emailed_at, published_at FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-21'",
    )
      .bind(indId)
      .first<{ emailed_at: number | null; published_at: number | null }>();

    expect(row!.emailed_at).toBeNull();
    // Review mode industry -> published_at is NULL until reviewed
    expect(row!.published_at).toBeNull();
  });

  it("email send failure reverts emailed_at to NULL and throws", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('fail-email-ind', 'Fail Email Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src', 'http://c/feed', 'c.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://c.com/1', 'http://c.com/1', 'Story C', 'Summary C', 'grouped', 'shaC', 1729468800000, 1729468800000, 1729468800000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event C', 1, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaC', 'approved', 'auto', ?2)",
    )
      .bind(art!.id, Date.parse("2026-10-21T05:00:00Z"))
      .run();

    const fakeEmail = new FakeEmail();
    fakeEmail.shouldFail = true;

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "false",
    };

    const msg: DigestMessage = {
      kind: "digest",
      industryId: indId,
      digestKind: "daily",
      periodStart: "2026-10-21",
    };

    await expect(
      buildDailyDigest(pipelineEnv, msg, Date.parse("2026-10-22T01:00:00Z")),
    ).rejects.toThrow("Failed to deliver email");

    const row = await env.DB.prepare(
      "SELECT emailed_at FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-21'",
    )
      .bind(indId)
      .first<{ emailed_at: number | null }>();

    expect(row!.emailed_at).toBeNull();
  });

  it("model returning invalid JSON falls back gracefully to article summary", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('bad-json-ind', 'Bad JSON Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src', 'http://d/feed', 'd.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://d.com/1', 'http://d.com/1', 'Story D', 'Fallback Article Summary', 'grouped', 'shaD', 1729468800000, 1729468800000, 1729468800000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event D', 1, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaD', 'approved', 'auto', ?2)",
    )
      .bind(art!.id, Date.parse("2026-10-21T05:00:00Z"))
      .run();

    const transport: ModelTransport = {
      run: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "NOT A VALID JSON AT ALL" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
      }),
    };

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL_ENABLED: "false",
      MODEL_CALLS_ENABLED: "true",
    };

    const msg: DigestMessage = {
      kind: "digest",
      industryId: indId,
      digestKind: "daily",
      periodStart: "2026-10-21",
    };

    await buildDailyDigest(
      pipelineEnv,
      msg,
      Date.parse("2026-10-22T01:00:00Z"),
      { transport },
    );

    const row = await env.DB.prepare(
      "SELECT intro, items_json FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-21'",
    )
      .bind(indId)
      .first<{ intro: string; items_json: string }>();

    expect(row!.intro).toBe("");
    const items = JSON.parse(row!.items_json);
    expect(items).toHaveLength(1);
    expect(items[0].oneLiner).toBe("Fallback Article Summary");
  });

  it("candidate selection: only events with approved articles in window, sorted by score DESC, excludes events later rejected", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('score-filter-ind', 'Score Filter Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src', 'http://s/feed', 's.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    // Article 1: low score (60)
    const art1 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://s.com/1', 'http://s.com/1', 'Low Score Story', 'Summary 1', 'grouped', 'sha1', 1000, 1000, 1000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event1 = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event Low', 1, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event1!.id, art1!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha1', 'approved', 'auto', ?2)",
    )
      .bind(art1!.id, Date.parse("2026-10-21T05:00:00Z"))
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, created_at, selected)
       VALUES (?1, 'v1', '{}', 'report', '{}', 60, 1000, 1)`,
    )
      .bind(art1!.id)
      .run();

    // Article 2: high score (95)
    const art2 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://s.com/2', 'http://s.com/2', 'High Score Story', 'Summary 2', 'grouped', 'sha2', 1000, 1000, 1000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event2 = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event High', 1, 2000, 2000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 2000)",
    )
      .bind(event2!.id, art2!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha2', 'approved', 'auto', ?2)",
    )
      .bind(art2!.id, Date.parse("2026-10-21T07:00:00Z"))
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, created_at, selected)
       VALUES (?1, 'v1', '{}', 'report', '{}', 95, 2000, 1)`,
    )
      .bind(art2!.id)
      .run();

    // Article 3: approved in window, but later body rejected (take-down)
    const art3 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://s.com/3', 'http://s.com/3', 'Takedown Story', 'Summary 3', 'grouped', 'sha3', 1000, 1000, 1000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event3 = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event Takedown', 1, 3000, 3000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 3000)",
    )
      .bind(event3!.id, art3!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha3', 'rejected', 'human', ?2)",
    )
      .bind(art3!.id, Date.parse("2026-10-21T06:00:00Z"))
      .run();

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL_ENABLED: "false",
      MODEL_CALLS_ENABLED: "false",
    };

    const msg: DigestMessage = {
      kind: "digest",
      industryId: indId,
      digestKind: "daily",
      periodStart: "2026-10-21",
    };

    await buildDailyDigest(
      pipelineEnv,
      msg,
      Date.parse("2026-10-22T01:00:00Z"),
    );

    const row = await env.DB.prepare(
      "SELECT items_json FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-21'",
    )
      .bind(indId)
      .first<{ items_json: string }>();

    const items = JSON.parse(row!.items_json);
    // Takedown event is excluded
    expect(items).toHaveLength(2);
    // Ordered by total_score DESC: event2 (95) comes before event1 (60)
    expect(items[0].eventId).toBe(event2!.id);
    expect(items[1].eventId).toBe(event1!.id);
  });
});

describe("handleGenerateBatch consumer", () => {
  function createFakeGenerateBatch(messages: DigestMessage[]) {
    const acked: string[] = [];
    const retried: string[] = [];

    const msgs: Message<DigestMessage>[] = messages.map((body, idx) => ({
      id: `msg-${idx}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {
        acked.push(`${body.industryId}:${body.periodStart}`);
      },
      retry: () => {
        retried.push(`${body.industryId}:${body.periodStart}`);
      },
    }));

    const batch: MessageBatch<DigestMessage> = {
      queue: "ainews-generate",
      messages: msgs as unknown as Message<DigestMessage>[],
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

  it("retries on CallInProgressError and does NOT commit a degraded fallback", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('cip-ind', 'CIP Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src', 'http://s/feed', 's.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://s.com/cip-1', 'http://s.com/cip-1', 'CIP Story', 'Summary CIP', 'grouped', 'sha-cip', 1000, 1000, 1000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event CIP', 1, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha-cip', 'approved', 'auto', ?2)",
    )
      .bind(art!.id, Date.parse("2026-10-21T05:00:00Z"))
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, created_at, selected)
       VALUES (?1, 'v1', '{}', 'report', '{}', 80, 1000, 1)`,
    )
      .bind(art!.id)
      .run();

    // Transport simulates CallInProgressError (another worker is currently generating)
    const inProgressTransport: ModelTransport = {
      run: async () => {
        throw new CallInProgressError("key-1");
      },
    };

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL_ENABLED: "false",
      MODEL_CALLS_ENABLED: "true",
    };

    const { batch, acked, retried } = createFakeGenerateBatch([
      {
        kind: "digest",
        industryId: indId,
        digestKind: "daily",
        periodStart: "2026-10-21",
      },
    ]);

    await handleGenerateBatch(batch, pipelineEnv, {
      transport: inProgressTransport,
    });

    // Message must be retried, NOT acked
    expect(retried).toHaveLength(1);
    expect(acked).toHaveLength(0);

    // No degraded digest row should have been inserted
    const row = await env.DB.prepare(
      "SELECT id FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-21'",
    )
      .bind(indId)
      .first<{ id: number }>();
    expect(row).toBeNull();
  });

  it("retries on email failure, and subsequent attempt completes emailing without duplicate row", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('email-retry-ind', 'Email Retry Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src', 'http://s/feed', 's.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://s.com/er-1', 'http://s.com/er-1', 'ER Story', 'Summary ER', 'grouped', 'sha-er', 1000, 1000, 1000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event ER', 1, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha-er', 'approved', 'auto', ?2)",
    )
      .bind(art!.id, Date.parse("2026-10-21T05:00:00Z"))
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, created_at, selected)
       VALUES (?1, 'v1', '{}', 'report', '{}', 80, 1000, 1)`,
    )
      .bind(art!.id)
      .run();

    const fakeEmail = new FakeEmail();
    fakeEmail.shouldFail = true;

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "false",
    };

    const firstRun = createFakeGenerateBatch([
      {
        kind: "digest",
        industryId: indId,
        digestKind: "daily",
        periodStart: "2026-10-21",
      },
    ]);

    // First attempt: email send fails
    await handleGenerateBatch(firstRun.batch, pipelineEnv);
    expect(firstRun.retried).toHaveLength(1);
    expect(firstRun.acked).toHaveLength(0);

    // Row exists in digests, but emailed_at is NULL
    const rowBefore = await env.DB.prepare(
      "SELECT id, emailed_at FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-21'",
    )
      .bind(indId)
      .first<{ id: number; emailed_at: number | null }>();
    expect(rowBefore).toBeDefined();
    expect(rowBefore!.emailed_at).toBeNull();

    // Second attempt: email succeeds
    fakeEmail.shouldFail = false;
    const secondRun = createFakeGenerateBatch([
      {
        kind: "digest",
        industryId: indId,
        digestKind: "daily",
        periodStart: "2026-10-21",
      },
    ]);

    await handleGenerateBatch(secondRun.batch, pipelineEnv);
    expect(secondRun.acked).toHaveLength(1);
    expect(secondRun.retried).toHaveLength(0);

    const rowAfter = await env.DB.prepare(
      "SELECT emailed_at FROM digests WHERE id = ?1",
    )
      .bind(rowBefore!.id)
      .first<{ emailed_at: number | null }>();
    expect(rowAfter!.emailed_at).not.toBeNull();
    expect(fakeEmail.sent).toHaveLength(1);
  });

  it("duplicate delivery of an empty digest does not send email", async () => {
    const fakeEmail = new FakeEmail();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('empty-dup-ind', 'Empty Dup Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "false",
    };

    const msg: DigestMessage = {
      kind: "digest",
      industryId: indId,
      digestKind: "daily",
      periodStart: "2026-10-21",
    };

    // First run creates empty digest
    await buildDailyDigest(
      pipelineEnv,
      msg,
      Date.parse("2026-10-22T01:00:00Z"),
    );
    expect(fakeEmail.sent).toHaveLength(0);

    // Second run (duplicate)
    await buildDailyDigest(
      pipelineEnv,
      msg,
      Date.parse("2026-10-22T01:00:00Z"),
    );
    expect(fakeEmail.sent).toHaveLength(0);
  });

  it("sendDigestEmail does not claim or send email for digest with status 'empty'", async () => {
    const fakeEmail = new FakeEmail();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('empty-guard-ind', 'Empty Guard Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();

    const dig = await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-23', 'UTC', 'empty', '', '[]', 1000, NULL) RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "false",
    };

    await sendDigestEmail(pipelineEnv, dig!.id, 2000);

    expect(fakeEmail.sent).toHaveLength(0);
    const row = await env.DB.prepare(
      "SELECT emailed_at FROM digests WHERE id = ?1",
    )
      .bind(dig!.id)
      .first<{ emailed_at: number | null }>();
    expect(row!.emailed_at).toBeNull();
  });

  it("buildDailyDigest ignores existing empty row when checking for emailing", async () => {
    const fakeEmail = new FakeEmail();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('empty-interleaved-ind', 'Empty Interleaved Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();

    // Pre-existing empty row (e.g. from an earlier empty run)
    await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-24', 'UTC', 'empty', '', '[]', 1000, NULL)`,
    )
      .bind(ind!.id)
      .run();

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "false",
    };

    const msg: DigestMessage = {
      kind: "digest",
      industryId: ind!.id,
      digestKind: "daily",
      periodStart: "2026-10-24",
    };

    await buildDailyDigest(pipelineEnv, msg, 2000);
    expect(fakeEmail.sent).toHaveLength(0);
  });
});
