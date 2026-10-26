import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildDailyDigest, buildDigest } from "../../src/pipeline/digest/build";
import { SITE_NAME } from "../../src/lib/site";
import {
  formatDigestEmail,
  sendDigestEmail,
} from "../../src/pipeline/digest/email";
import {
  enqueueDueDigests,
  enqueueDueWeeklyDigests,
} from "../../src/pipeline/digest/schedule";
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

  it("a digest item under a system placeholder source shows the document host", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('placeholder-ind', 'Placeholder Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;
    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, status, created_at) VALUES (?1, 'html', 'Primary documents (system)', 'system:primary-documents', 'paused', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'https://www.sec.gov/doc-p', 'https://www.sec.gov/doc-p', 'Primary filing', 'Filing summary', 'analyzed', 'shaP', 1729468800000, 1729468800000, 1729468800000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();
    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event P', 1, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaP', 'approved', 'editor', ?2)",
    )
      .bind(art!.id, Date.parse("2026-10-21T05:00:00Z"))
      .run();

    const transport: ModelTransport = {
      run: async () => ({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "{}" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
      }),
    };
    await buildDailyDigest(
      { ...env, EMAIL_ENABLED: "false", MODEL_CALLS_ENABLED: "true" },
      {
        kind: "digest",
        industryId: indId,
        digestKind: "daily",
        periodStart: "2026-10-21",
      },
      Date.parse("2026-10-22T01:00:00Z"),
      { transport },
    );

    const row = await env.DB.prepare(
      "SELECT items_json FROM digests WHERE industry_id = ?1 AND period_start = '2026-10-21'",
    )
      .bind(indId)
      .first<{ items_json: string }>();
    const items = JSON.parse(row!.items_json);
    expect(items).toHaveLength(1);
    expect(items[0].sourceName).toBe("sec.gov");
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

  it("digest logical key includes input payload hash so candidate revision change does not reuse stale model call", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('key-hash-ind', 'Key Hash Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src', 'http://s/feed', 's.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://s.com/kh-1', 'http://s.com/kh-1', 'KH Story', 'Summary KH', 'grouped', 'sha-kh', 1000, 1000, 1000) RETURNING id`,
    )
      .bind(indId, source!.id)
      .first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Event KH', 0, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha-kh', 'approved', 'auto', ?2)",
    )
      .bind(art!.id, Date.parse("2026-10-21T05:00:00Z"))
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, created_at, selected)
       VALUES (?1, 'v1', '{}', 'report', '{}', 80, 1000, 1)`,
    )
      .bind(art!.id)
      .run();

    const testTransport: ModelTransport = {
      run: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: JSON.stringify({
                    intro: "Generated intro",
                    items: [
                      { event_id: event!.id, one_liner: "Generated one liner" },
                    ],
                  }),
                },
              ],
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

    const runNow = Date.parse("2026-10-22T01:00:00Z");
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, spent_micros, reserved_micros)
       VALUES ('2026-10-22', 'gateway', 10000000, 0, 0)
       ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
    ).run();

    // First run with revision 0
    await buildDailyDigest(pipelineEnv, msg, runNow, {
      transport: testTransport,
    });

    // Inspect llm_calls row key
    const callRows1 = await env.DB.prepare(
      "SELECT logical_key FROM llm_calls WHERE logical_key LIKE ?1",
    )
      .bind(`digest:${indId}:%`)
      .all<{ logical_key: string }>();
    expect(callRows1.results).toHaveLength(1);
    const key1 = callRows1.results[0].logical_key;

    // Delete digest row to simulate retry before commit, and bump event revision
    await env.DB.prepare("DELETE FROM digests WHERE industry_id = ?1")
      .bind(indId)
      .run();
    await env.DB.prepare("UPDATE events SET revision = 1 WHERE id = ?1")
      .bind(event!.id)
      .run();

    // Second run with revision 1
    await buildDailyDigest(pipelineEnv, msg, runNow, {
      transport: testTransport,
    });

    const callRows2 = await env.DB.prepare(
      "SELECT logical_key FROM llm_calls WHERE logical_key LIKE ?1 ORDER BY id ASC",
    )
      .bind(`digest:${indId}:%`)
      .all<{ logical_key: string }>();
    expect(callRows2.results).toHaveLength(2);
    const key2 = callRows2.results[1].logical_key;

    // Because revision changed, the logical key is different and did not reuse stale row
    expect(key2).not.toBe(key1);
  });
});

describe("buildWeeklyDigest", () => {
  it("schedules weekly digest on Monday and honors deduplication", async () => {
    const queue = new FakeQueue();
    // 2026-10-26 09:00:00 UTC is a Monday. Target weekly periodStart is 2026-10-19.
    const mondayNow = Date.parse("2026-10-26T09:00:00.000Z");

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('weekly-sched', 'Weekly Sched', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();

    const pipelineEnv: Pick<PipelineEnv, "DB" | "Q_GENERATE"> = {
      DB: env.DB,
      Q_GENERATE: queue as unknown as Queue,
    };

    const messages = await enqueueDueWeeklyDigests(
      pipelineEnv,
      mondayNow,
      "UTC",
      [{ id: ind!.id }],
    );
    expect(
      messages.some(
        (m) =>
          m.industryId === ind!.id &&
          m.digestKind === "weekly" &&
          m.periodStart === "2026-10-19",
      ),
    ).toBe(true);

    // If weekly row exists, does not schedule again
    await env.DB.prepare(
      "INSERT INTO digests (industry_id, kind, period_start, timezone, status, created_at) VALUES (?1, 'weekly', '2026-10-19', 'UTC', 'ready', ?2)",
    )
      .bind(ind!.id, mondayNow)
      .run();

    const secondRun = await enqueueDueWeeklyDigests(
      pipelineEnv,
      mondayNow,
      "UTC",
      [{ id: ind!.id }],
    );
    expect(secondRun.some((m) => m.industryId === ind!.id)).toBe(false);

    // On Tuesday 2026-10-27, not due unless forced
    const tuesdayNow = Date.parse("2026-10-27T09:00:00.000Z");
    const tuesdayRun = await enqueueDueWeeklyDigests(
      pipelineEnv,
      tuesdayNow,
      "UTC",
      [{ id: ind!.id }],
    );
    expect(tuesdayRun).toHaveLength(0);
  });

  it("when 0 events match window: status = 'empty', does not call model, does not email", async () => {
    const fakeEmail = new FakeEmail();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('weekly-empty', 'Weekly Empty', 'review', 1000) RETURNING id",
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
      digestKind: "weekly",
      periodStart: "2026-10-12",
    };

    await buildDigest(pipelineEnv, msg, Date.now(), { transport });

    const row = await env.DB.prepare(
      "SELECT status, items_json FROM digests WHERE industry_id = ?1 AND kind = 'weekly' AND period_start = '2026-10-12'",
    )
      .bind(ind!.id)
      .first<{ status: string; items_json: string }>();

    expect(row).toBeDefined();
    expect(row!.status).toBe("empty");
    expect(row!.items_json).toBe("[]");
    expect(modelCalled).toBe(false);
    expect(fakeEmail.sent).toHaveLength(0);
  });

  it("selects events approved this week OR revised this week (with approved article) using reason slot", async () => {
    const fakeEmail = new FakeEmail();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('weekly-cand', 'Weekly Cand', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, kind, site_domain, feed_url, fetch_rung, status, created_at) VALUES (?1, 'Weekly Src', 'rss', 'weekly.com', 'https://weekly.com/rss', 1, 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    // Week window: 2026-10-19T00:00:00Z to 2026-10-26T00:00:00Z
    const midweekMs = Date.parse("2026-10-21T12:00:00.000Z");
    const priorWeekMs = Date.parse("2026-10-10T12:00:00.000Z");

    // Event 1: Article approved midweek -> should be selected
    const ev1 = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev 1', 1, ?2, ?2) RETURNING id",
    )
      .bind(indId, midweekMs)
      .first<{ id: number }>();
    const art1 = await env.DB.prepare(
      "INSERT INTO articles (industry_id, source_id, url, canonical_url, title, stage, body_sha, fetched_at, stage_updated_at) VALUES (?1, ?2, 'https://weekly.com/1', 'https://weekly.com/1', 'Event 1 Title', 'grouped', 'sha1', ?3, ?3) RETURNING id",
    )
      .bind(indId, source!.id, midweekMs)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, ?3)",
    )
      .bind(ev1!.id, art1!.id, midweekMs)
      .run();
    await env.DB.prepare(
      "INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, selected, created_at) VALUES (?1, 'v1', '{}', 'report', '{}', 85, 1, ?2)",
    )
      .bind(art1!.id, midweekMs)
      .run();
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha1', 'approved', 'editor', ?2)",
    )
      .bind(art1!.id, midweekMs)
      .run();

    // Event 2: Old article approved in prior week, BUT event updated with new revision this week -> should be selected
    const ev2 = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev 2', 2, ?2, ?3) RETURNING id",
    )
      .bind(indId, priorWeekMs, midweekMs)
      .first<{ id: number }>();
    const art2 = await env.DB.prepare(
      "INSERT INTO articles (industry_id, source_id, url, canonical_url, title, stage, body_sha, fetched_at, stage_updated_at) VALUES (?1, ?2, 'https://weekly.com/2', 'https://weekly.com/2', 'Event 2 Title', 'grouped', 'sha2', ?3, ?3) RETURNING id",
    )
      .bind(indId, source!.id, priorWeekMs)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, ?3)",
    )
      .bind(ev2!.id, art2!.id, priorWeekMs)
      .run();
    await env.DB.prepare(
      "INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, selected, created_at) VALUES (?1, 'v1', '{}', 'report', '{}', 75, 1, ?2)",
    )
      .bind(art2!.id, priorWeekMs)
      .run();
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha2', 'approved', 'editor', ?2)",
    )
      .bind(art2!.id, priorWeekMs)
      .run();

    // Event 3: Updated this week, but has ZERO approved articles -> must NOT be selected
    const ev3 = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Ev 3', 2, ?2, ?3) RETURNING id",
    )
      .bind(indId, priorWeekMs, midweekMs)
      .first<{ id: number }>();
    const art3 = await env.DB.prepare(
      "INSERT INTO articles (industry_id, source_id, url, canonical_url, title, stage, body_sha, fetched_at, stage_updated_at) VALUES (?1, ?2, 'https://weekly.com/3', 'https://weekly.com/3', 'Event 3 Title', 'grouped', 'sha3', ?3, ?3) RETURNING id",
    )
      .bind(indId, source!.id, priorWeekMs)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, ?3)",
    )
      .bind(ev3!.id, art3!.id, priorWeekMs)
      .run();

    const transport: ModelTransport = {
      run: async (_model, _request) => {
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      intro: "Weekly overarching narrative of events.",
                      items: [
                        { event_id: ev1!.id, one_liner: "Event 1 one liner" },
                        { event_id: ev2!.id, one_liner: "Event 2 one liner" },
                      ],
                    }),
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 80,
            totalTokenCount: 180,
          },
        };
      },
    };

    const pipelineEnv: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      MODEL_CALLS_ENABLED: "true",
    };

    // Budget setup
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, spent_micros, reserved_micros)
       VALUES ('2026-10-26', 'gateway', 10000000, 0, 0)
       ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
    ).run();

    const msg: DigestMessage = {
      kind: "digest",
      industryId: indId,
      digestKind: "weekly",
      periodStart: "2026-10-19",
    };

    const testNow = Date.parse("2026-10-26T10:00:00.000Z");
    await buildDigest(pipelineEnv, msg, testNow, { transport });

    const row = await env.DB.prepare(
      "SELECT id, kind, status, model, intro, items_json, published_at FROM digests WHERE industry_id = ?1 AND kind = 'weekly' AND period_start = '2026-10-19'",
    )
      .bind(indId)
      .first<{
        id: number;
        kind: string;
        status: string;
        model: string;
        intro: string;
        items_json: string;
        published_at: number | null;
      }>();

    expect(row).toBeDefined();
    expect(row!.kind).toBe("weekly");
    expect(row!.status).toBe("ready");
    expect(row!.model).toBe("reason");
    expect(row!.intro).toBe("Weekly overarching narrative of events.");
    expect(row!.published_at).toBe(testNow); // auto publish_mode

    const items = JSON.parse(row!.items_json) as { eventId: number }[];
    expect(items).toHaveLength(2);
    expect(items.map((it) => it.eventId)).toEqual([ev1!.id, ev2!.id]);

    // Verify llm_calls ledger recorded slot as "reason"
    const callRow = await env.DB.prepare(
      "SELECT slot, model FROM llm_calls WHERE logical_key LIKE ?1",
    )
      .bind(`digest:${indId}:weekly:2026-10-19:%`)
      .first<{ slot: string; model: string }>();
    expect(callRow).toBeDefined();
    expect(callRow!.slot).toBe("reason");

    // Email delivered with Weekly Digest subject
    expect(fakeEmail.sent).toHaveLength(1);
    const sent = fakeEmail.sent[0] as { subject: string; text: string };
    expect(sent.subject).toContain("weekly digest — 2026-10-19");
    expect(sent.text).toContain("Weekly Digest");
  });

  it("same weekly digest message delivered 3 times: 1 row in digests, reason called once, email called once", async () => {
    const fakeEmail = new FakeEmail();
    let reasonCalls = 0;
    const fakeTransport: ModelTransport = {
      run: async () => {
        reasonCalls++;
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Weekly triple delivery test synthesis." }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 30,
            totalTokenCount: 80,
          },
        };
      },
    };

    const envWithFakes: PipelineEnv = {
      ...env,
      EMAIL: fakeEmail as unknown as SendEmail,
      EMAIL_ENABLED: "true",
      ADMIN_EMAIL: "admin@test.com",
      SITE_URL: "https://news.ioenv.com",
      MODEL_CALLS_ENABLED: "true",
    };

    // Budget setup
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, spent_micros, reserved_micros)
       VALUES ('2026-10-21', 'gateway', 10000000, 0, 0)
       ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
    ).run();

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('weekly-repeat-ind', 'Weekly Repeat', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const source = await env.DB.prepare(
      "INSERT INTO sources (industry_id, kind, name, feed_url, site_domain, created_at) VALUES (?1, 'rss', 'Src W', 'http://w/feed', 'w.com', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();

    const midweekMs = Date.parse("2026-10-21T12:00:00.000Z");
    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, url, canonical_url, title, summary, stage, body_sha, published_at, fetched_at, stage_updated_at)
       VALUES (?1, ?2, 'http://w.com/repeat-1', 'http://w.com/repeat-1', 'Weekly Story', 'Summary W', 'grouped', 'wsha1', ?3, ?3, ?3) RETURNING id`,
    )
      .bind(indId, source!.id, midweekMs)
      .first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Weekly Event 1', 1, ?2, ?2) RETURNING id",
    )
      .bind(indId, midweekMs)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, ?3)",
    )
      .bind(event!.id, art!.id, midweekMs)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'wsha1', 'approved', 'auto', ?2)",
    )
      .bind(art!.id, midweekMs)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, created_at, selected, title_en, summary_en)
       VALUES (?1, 'v1', '{}', 'report', '{}', 85, ?2, 1, 'Written W Title', 'Written W Summary')`,
    )
      .bind(art!.id, midweekMs)
      .run();

    const msg: DigestMessage = {
      kind: "digest",
      digestKind: "weekly",
      industryId: indId,
      periodStart: "2026-10-19",
    };

    // Deliver 3 times concurrently / consecutively
    await buildDigest(envWithFakes, msg, midweekMs, {
      transport: fakeTransport,
    });
    await buildDigest(envWithFakes, msg, midweekMs, {
      transport: fakeTransport,
    });
    await buildDigest(envWithFakes, msg, midweekMs, {
      transport: fakeTransport,
    });

    const rows = await env.DB.prepare(
      "SELECT id, kind, period_start, emailed_at FROM digests WHERE industry_id = ?1 AND kind = 'weekly'",
    )
      .bind(indId)
      .all<{
        id: number;
        kind: string;
        period_start: string;
        emailed_at: number;
      }>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.period_start).toBe("2026-10-19");
    expect(rows.results[0]?.emailed_at).toBe(midweekMs);
    expect(reasonCalls).toBe(1);
    expect(fakeEmail.sent).toHaveLength(1);
  });

  it("forceWeekly option enqueues weekly digest on non-Monday", async () => {
    const queue = new FakeQueue();
    const testEnv: Pick<PipelineEnv, "DB" | "Q_GENERATE"> = {
      DB: env.DB,
      Q_GENERATE: queue as unknown as Queue,
    };

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('force-ind', 'Force Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();

    // Wednesday, 2026-10-21 (not Monday)
    const wednesdayMs = Date.parse("2026-10-21T10:00:00.000Z");
    const msgs = await enqueueDueDigests(testEnv, wednesdayMs, {
      forceWeekly: true,
    });
    expect(msgs.length).toBeGreaterThanOrEqual(1);

    const weeklyMsgs = queue.sent.filter(
      (m) => m.digestKind === "weekly" && m.industryId === ind!.id,
    );
    expect(weeklyMsgs).toHaveLength(1);
    expect(weeklyMsgs[0]?.periodStart).toBe("2026-10-12"); // Prior week Monday
  });
});

describe("formatDigestEmail", () => {
  it("names the site in the subject, text and html", () => {
    const mail = formatDigestEmail(
      {
        id: 1,
        industryId: 1,
        industrySlug: "technology",
        industryName: "Technology",
        periodStart: "2026-10-26",
        publishedAt: 1,
        intro: "",
        items: [],
      },
      "https://news.ioenv.com",
    );
    expect(mail.subject.startsWith(`[${SITE_NAME}] Technology`)).toBe(true);
    expect(mail.text).toContain(`${SITE_NAME} — Technology`);
    expect(mail.html).toContain(`View on ${SITE_NAME}`);
    expect(mail.subject + mail.text + mail.html).not.toContain("Personal News");
  });
});
