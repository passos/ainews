// Reader watch judging, the daily attempt cap and the sweep (#132 slice 3,
// architecture §6 "读者 watch": 判定 / 清理).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateEventWatches } from "../../src/pipeline/watch/evaluate";
import { buildWatchJudgeQuestion } from "../../src/pipeline/watch/prompts";
import { utcDay } from "../../src/providers/budget";
import {
  BudgetExceededError,
  type ModelClient,
} from "../../src/providers/models";
import type { ModelTransport } from "../../src/providers/transport";

const DAY = 86_400_000;
const NOW = Date.UTC(2031, 0, 15, 12, 0, 0);
const TODAY = utcDay(NOW);
const YESTERDAY = NOW - DAY;

const OFF = { ...env, READER_WATCH_ENABLED: "false" };
const ON = { ...env, READER_WATCH_ENABLED: "true" };
const PAID = {
  ...env,
  READER_WATCH_ENABLED: "true",
  MODEL_CALLS_ENABLED: "true",
};

let sourceId: number;
let techId: number;
let financeId: number;
let seq = 0;

async function industry(slug: string): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO industries (slug, name, publish_mode, primary_domains, config, config_version, created_at)
     VALUES (?1, ?1, 'review', '[]', '{}', 1, 1000)
     ON CONFLICT DO NOTHING`,
  )
    .bind(slug)
    .run();
  return (await env.DB.prepare(`SELECT id FROM industries WHERE slug = ?1`)
    .bind(slug)
    .first<{ id: number }>())!.id;
}

/** One event (revision 1) with one approved article, both at t = 1000. */
async function seedEvent(
  industryId: number,
  title: string,
): Promise<{ eventId: number; articleId: number }> {
  seq += 1;
  const tag = `rw3-${seq}-${Math.random().toString(16).slice(2)}`;
  const eventId = (await env.DB.prepare(
    `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
     VALUES (?1, ?2, 1, 1000, 1000) RETURNING id`,
  )
    .bind(industryId, title)
    .first<{ id: number }>())!.id;
  const articleId = (await env.DB.prepare(
    `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
     VALUES (?1, ?2, ?3, ?3, ?4, 'Summary text', ?5, 'grouped', 1000, 1000)
     RETURNING id`,
  )
    .bind(
      industryId,
      sourceId,
      `https://example.com/${tag}`,
      title,
      `sha-${tag}`,
    )
    .first<{ id: number }>())!.id;
  await env.DB.prepare(
    `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
     VALUES (?1, ?2, 'approved', 'admin', 1000)`,
  )
    .bind(articleId, `sha-${tag}`)
    .run();
  await env.DB.prepare(
    `INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)`,
  )
    .bind(eventId, articleId)
    .run();
  return { eventId, articleId };
}

async function watch(
  kind: "admin" | "reader",
  keyword: string,
  opts: {
    industryId?: number | null;
    createdAt?: number;
    question?: string;
    criteria?: string;
  } = {},
): Promise<number> {
  seq += 1;
  const slug = kind === "reader" ? `r-rw3-${seq}` : `admin-rw3-${seq}`;
  return (await env.DB.prepare(
    `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at, owner_kind, token_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, ?7, ?8) RETURNING id`,
  )
    .bind(
      slug,
      opts.question ?? `Question about ${keyword}?`,
      opts.criteria ?? `Criteria about ${keyword}`,
      JSON.stringify([keyword]),
      opts.industryId ?? null,
      opts.createdAt ?? 500,
      kind,
      kind === "reader" ? `hash-${slug}` : null,
    )
    .first<{ id: number }>())!.id;
}

function mockModels(noul: number) {
  const judge = vi.fn().mockResolvedValue({ progress: { noul } });
  const generateText = vi
    .fn()
    .mockResolvedValue({ text: "Admin summary.", finishReason: "STOP" });
  return {
    judge,
    generateText,
    client: { judge, generateText } as unknown as ModelClient,
  };
}

/** Jev transport stub; `fail(n)` makes the n-th call (1-based) throw. */
function jevTransport(
  noul: number,
  fail: (n: number) => boolean = () => false,
): ModelTransport & { calls: number } {
  const t = {
    calls: 0,
    run: async () => {
      t.calls += 1;
      if (fail(t.calls)) throw new Error("network reset");
      return {
        state: "Completed",
        result: {
          model: "jev-1.13.0",
          answers: { progress: { type: "noul", noul } },
          usage: { input_tokens: 400, output_tokens: 0 },
        },
      };
    },
  };
  return t;
}

async function marker(eventId: number): Promise<number> {
  return (await env.DB.prepare(
    `SELECT watch_evaluated_revision AS r FROM events WHERE id = ?1`,
  )
    .bind(eventId)
    .first<{ r: number }>())!.r;
}

async function admissions(day: string): Promise<number> {
  return (await env.DB.prepare(
    `SELECT count(*) AS n FROM reader_watch_admissions WHERE day = ?1`,
  )
    .bind(day)
    .first<{ n: number }>())!.n;
}

async function fillAdmissions(day: string, n: number): Promise<void> {
  const stmts = [];
  for (let i = 0; i < n; i++) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO reader_watch_admissions (logical_key, day, created_at) VALUES (?1, ?2, ?3)`,
      ).bind(`watch:judge:prefill:${i}`, day, NOW - 1000),
    );
  }
  await env.DB.batch(stmts);
}

async function hits(eventId: number) {
  return (
    await env.DB.prepare(
      `SELECT watch_id, summary, rationale, status FROM watch_hits WHERE event_id = ?1 ORDER BY watch_id`,
    )
      .bind(eventId)
      .all<{
        watch_id: number;
        summary: string;
        rationale: string;
        status: string;
      }>()
  ).results;
}

async function ledgerFor(watchId: number) {
  return env.DB.prepare(
    `SELECT tier, status, error FROM llm_calls WHERE logical_key LIKE ?1`,
  )
    .bind(`watch:judge:${watchId}:%`)
    .first<{ tier: number; status: string; error: string | null }>();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM watch_hits`),
    env.DB.prepare(`DELETE FROM watches`),
    env.DB.prepare(`DELETE FROM reader_watch_admissions`),
    env.DB.prepare(`DELETE FROM llm_calls`),
    env.DB.prepare(`DELETE FROM budgets`),
  ]);
  techId = await industry("rw3-tech");
  financeId = await industry("finance");
  const src = await env.DB.prepare(
    `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
     VALUES (?1, 'RW3 Source', 'https://example.com/rw3.xml', 'example.com', 'rss', 'active', 1000)
     ON CONFLICT DO NOTHING RETURNING id`,
  )
    .bind(techId)
    .first<{ id: number }>();
  sourceId =
    src?.id ??
    (await env.DB.prepare(
      `SELECT id FROM sources WHERE feed_url = 'https://example.com/rw3.xml'`,
    ).first<{ id: number }>())!.id;
});

describe("reader watch judging (#132)", () => {
  it("does not judge reader watches while the switch is off", async () => {
    const { eventId } = await seedEvent(techId, "GPU pricing announced");
    const adminId = await watch("admin", "GPU");
    await watch("reader", "GPU");
    const m = mockModels(0.1);

    await evaluateEventWatches(OFF, eventId, NOW, {
      models: m.client,
      readerModels: m.client,
    });

    expect(m.judge).toHaveBeenCalledTimes(1);
    expect(m.judge.mock.calls[0][0]).toMatch(
      new RegExp(`^watch:judge:${adminId}:`),
    );
    expect(await marker(eventId)).toBe(1);
    expect(await admissions(TODAY)).toBe(0);
  });

  it("judges a reader watch with the admin prompt builder when the switch is on", async () => {
    const { eventId } = await seedEvent(techId, "GPU pricing announced");
    const question = "Will GPU prices fall this year?";
    const criteria = "An official price cut announcement";
    const readerId = await watch("reader", "GPU", { question, criteria });
    const admin = mockModels(0.1);
    const reader = mockModels(0.1);

    await evaluateEventWatches(ON, eventId, NOW, {
      models: admin.client,
      readerModels: reader.client,
    });

    expect(admin.judge).not.toHaveBeenCalled();
    expect(reader.judge).toHaveBeenCalledTimes(1);
    const [key, , questions] = reader.judge.mock.calls[0];
    expect(key).toMatch(new RegExp(`^watch:judge:${readerId}:`));
    expect(questions).toEqual(buildWatchJudgeQuestion(question, criteria));
    expect(await admissions(TODAY)).toBe(1);
    expect(await marker(eventId)).toBe(1);
  });

  it("skips Finance events for reader watches only", async () => {
    await watch("reader", "earnings");
    const adminId = await watch("admin", "earnings");

    const finance = await seedEvent(financeId, "Quarterly earnings released");
    const fAdmin = mockModels(0.1);
    const fReader = mockModels(0.1);
    await evaluateEventWatches(ON, finance.eventId, NOW, {
      models: fAdmin.client,
      readerModels: fReader.client,
    });
    expect(fReader.judge).not.toHaveBeenCalled();
    expect(fAdmin.judge).toHaveBeenCalledTimes(1);
    expect(fAdmin.judge.mock.calls[0][0]).toMatch(
      new RegExp(`^watch:judge:${adminId}:`),
    );
    expect(await marker(finance.eventId)).toBe(1);

    // Control: the same reader watch is judged on a non-Finance event.
    const tech = await seedEvent(techId, "Chip earnings released");
    const tReader = mockModels(0.1);
    await evaluateEventWatches(ON, tech.eventId, NOW, {
      models: mockModels(0.1).client,
      readerModels: tReader.client,
    });
    expect(tReader.judge).toHaveBeenCalledTimes(1);
  });

  it("stores a delivered hit without a write call", async () => {
    const { eventId, articleId } = await seedEvent(techId, "GPU pricing cut");
    const readerId = await watch("reader", "GPU");
    const adminId = await watch("admin", "GPU");
    const admin = mockModels(0.9);
    const reader = mockModels(0.9);

    await evaluateEventWatches(ON, eventId, NOW, {
      models: admin.client,
      readerModels: reader.client,
    });

    expect(reader.generateText).not.toHaveBeenCalled();
    expect(admin.generateText).toHaveBeenCalledTimes(1);
    expect(admin.generateText.mock.calls[0][1]).toMatch(
      new RegExp(`^watch:summary:${adminId}:`),
    );
    const rows = await hits(eventId);
    expect(rows.map((r) => [r.watch_id, r.status, r.summary])).toEqual([
      [readerId, "delivered", ""],
      [adminId, "pending_review", "Admin summary."],
    ]);
    expect(JSON.parse(rows[0].rationale).articleIds).toEqual([articleId]);
  });

  it("skips reader watches at the daily cap, still evaluates a later admin watch, keeps the marker behind", async () => {
    const { eventId } = await seedEvent(techId, "GPU pricing cut");
    const readerId = await watch("reader", "GPU");
    const adminId = await watch("admin", "GPU");
    expect(adminId).toBeGreaterThan(readerId);
    await fillAdmissions(TODAY, 500);
    const admin = mockModels(0.9);
    const reader = mockModels(0.9);

    await expect(
      evaluateEventWatches(ON, eventId, NOW, {
        models: admin.client,
        readerModels: reader.client,
      }),
    ).resolves.toBeDefined();

    expect(reader.judge).not.toHaveBeenCalled();
    expect(await admissions(TODAY)).toBe(500);
    expect(admin.judge).toHaveBeenCalledTimes(1);
    expect((await hits(eventId)).map((r) => [r.watch_id, r.status])).toEqual([
      [adminId, "pending_review"],
    ]);
    expect(await marker(eventId)).toBe(0);
  });

  it("refuses an old key once today has 500 sends", async () => {
    const { eventId } = await seedEvent(techId, "GPU pricing cut");
    await watch("reader", "GPU");

    // Yesterday: registered, sent, no completed ledger row.
    const first = mockModels(0.1);
    first.judge.mockRejectedValueOnce(new Error("network reset"));
    await expect(
      evaluateEventWatches(ON, eventId, YESTERDAY, {
        models: mockModels(0.1).client,
        readerModels: first.client,
      }),
    ).rejects.toThrow("network reset");
    expect(await admissions(utcDay(YESTERDAY))).toBe(1);

    await fillAdmissions(TODAY, 500);
    const second = mockModels(0.1);
    await evaluateEventWatches(ON, eventId, NOW, {
      models: mockModels(0.1).client,
      readerModels: second.client,
    });

    expect(second.judge).not.toHaveBeenCalled();
    expect(await admissions(TODAY)).toBe(500);
    expect(await marker(eventId)).toBe(0);
  });

  it("counts a retry of the same key as a second attempt", async () => {
    const { eventId } = await seedEvent(techId, "GPU pricing cut");
    const readerId = await watch("reader", "GPU");
    const transport = jevTransport(0.1, (n) => n === 1);
    const deps = { transport, now: () => NOW };

    await expect(
      evaluateEventWatches(PAID, eventId, NOW, deps),
    ).rejects.toThrow("network reset");
    expect((await ledgerFor(readerId))?.status).toBe("failed");
    expect(await marker(eventId)).toBe(0);

    await evaluateEventWatches(PAID, eventId, NOW, deps);

    expect(transport.calls).toBe(2);
    expect(await admissions(TODAY)).toBe(2);
    expect((await ledgerFor(readerId))?.status).toBe("completed");
    expect(await marker(eventId)).toBe(1);
  });

  it("does not count a ledger cache hit", async () => {
    const { eventId } = await seedEvent(techId, "GPU pricing cut");
    const readerId = await watch("reader", "GPU");
    const transport = jevTransport(0.1);
    const deps = { transport, now: () => NOW };

    await evaluateEventWatches(PAID, eventId, NOW, deps);
    expect((await ledgerFor(readerId))?.status).toBe("completed");
    expect(await admissions(TODAY)).toBe(1);

    // The same input is evaluated again, as if the first run had left the
    // revision unmarked (e.g. stopped at the cap).
    await env.DB.prepare(
      `UPDATE events SET watch_evaluated_revision = 0, watch_evaluated_through = NULL
       WHERE id = ?1`,
    )
      .bind(eventId)
      .run();
    const again = await evaluateEventWatches(PAID, eventId, NOW, deps);

    // The judge was reached and answered from the ledger.
    expect(again.evaluatedCount).toBe(1);
    expect(transport.calls).toBe(1);
    expect(await admissions(TODAY)).toBe(1);
    expect(await marker(eventId)).toBe(1);
  });

  it("refuses a reader judge at tier 5 while an admin watch passes at tier 4", async () => {
    // cap 1,900,000, default reserves: tier 5 needs spent + est <= 700,000,
    // tier 4 needs spent + est <= 800,000.
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
       VALUES (?1, 'gateway', 1900000, 0, 750000)`,
    )
      .bind(TODAY)
      .run();
    const readerId = await watch("reader", "lidar");
    const adminId = await watch("admin", "battery");
    const a = await seedEvent(techId, "Lidar sensor launch");
    const b = await seedEvent(techId, "Battery chemistry launch");
    const transport = jevTransport(0.1);
    const deps = { transport, now: () => NOW };

    const error = await evaluateEventWatches(PAID, a.eventId, NOW, deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).tier).toBe(5);
    expect(await ledgerFor(readerId)).toEqual({
      tier: 5,
      status: "failed",
      error: "budget_exceeded",
    });
    expect(await marker(a.eventId)).toBe(0);

    await evaluateEventWatches(PAID, b.eventId, NOW, deps);
    expect(await ledgerFor(adminId)).toMatchObject({
      tier: 4,
      status: "completed",
    });
    expect(transport.calls).toBe(1);
  });

  it("keeps the #85 rules for reader watches", async () => {
    const m = mockModels(0.1);
    const deps = { models: m.client, readerModels: m.client };

    // Rule 3: no keyword match.
    const kw = await seedEvent(techId, "GPU pricing cut");
    await watch("reader", "quantum");
    await evaluateEventWatches(ON, kw.eventId, NOW, deps);
    expect(m.judge).not.toHaveBeenCalled();
    expect(await admissions(TODAY)).toBe(0);
    await env.DB.prepare(`DELETE FROM watches`).run();

    // Rule 2: the article was already cited by a hit of this watch.
    const cited = await seedEvent(techId, "GPU pricing cut");
    const citing = await watch("reader", "GPU");
    await env.DB.prepare(
      `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale, status)
       VALUES (?1, ?2, 0, 900, '', ?3, 'delivered')`,
    )
      .bind(
        citing,
        cited.eventId,
        JSON.stringify({ articleIds: [cited.articleId] }),
      )
      .run();
    await evaluateEventWatches(ON, cited.eventId, NOW, deps);
    expect(m.judge).not.toHaveBeenCalled();
    await env.DB.prepare(`DELETE FROM watch_hits`).run();
    await env.DB.prepare(`DELETE FROM watches`).run();

    // Rule 2: approved before the watch existed.
    const early = await seedEvent(techId, "GPU pricing cut");
    await watch("reader", "GPU", { createdAt: 2000 });
    await evaluateEventWatches(ON, early.eventId, NOW, deps);
    expect(m.judge).not.toHaveBeenCalled();
    expect(await admissions(TODAY)).toBe(0);

    // Control: a reader watch that passes the rules is judged.
    const ok = await seedEvent(techId, "GPU pricing cut");
    await watch("reader", "GPU");
    await evaluateEventWatches(ON, ok.eventId, NOW, deps);
    expect(m.judge).toHaveBeenCalledTimes(1);
  });
});

describe("sweepReaderWatches (#132)", () => {
  async function row(
    kind: "admin" | "reader",
    createdAt: number,
    lastReadAt: number | null,
    status: "active" | "paused" = "active",
    disabledAt: number | null = null,
  ): Promise<number> {
    const id = await watch(kind, "x", { createdAt });
    await env.DB.prepare(
      `UPDATE watches SET last_read_at = ?2, status = ?3, disabled_at = ?4 WHERE id = ?1`,
    )
      .bind(id, lastReadAt, status, disabledAt)
      .run();
    return id;
  }

  async function state(id: number) {
    return env.DB.prepare(
      `SELECT status, disabled_at, updated_at FROM watches WHERE id = ?1`,
    )
      .bind(id)
      .first<{
        status: string;
        disabled_at: number | null;
        updated_at: number;
      }>();
  }

  it("disables unread reader watches and purges old admissions", async () => {
    const { sweepReaderWatches } =
      await import("../../src/pipeline/watch/reader");
    const old = NOW - 60 * DAY;
    const neverRead3d1m = await row("reader", NOW - 3 * DAY - 60_000, null);
    const neverRead3d = await row("reader", NOW - 3 * DAY, null);
    const neverRead2d = await row("reader", NOW - 2 * DAY, null);
    const read29d = await row("reader", old, NOW - 29 * DAY);
    const read30d = await row("reader", old, NOW - 30 * DAY);
    const read31d = await row("reader", old, NOW - 31 * DAY);
    const adminNever = await row("admin", old, null);
    const adminRead = await row("admin", old, NOW - 31 * DAY);
    const paused = await row("reader", old, null, "paused", 123);

    await env.DB.batch(
      [8, 7, 6].map((d) =>
        env.DB.prepare(
          `INSERT INTO reader_watch_admissions (logical_key, day, created_at) VALUES (?1, ?2, ?3)`,
        ).bind(`k${d}`, utcDay(NOW - d * DAY), NOW - d * DAY),
      ),
    );

    const res = await sweepReaderWatches({ DB: env.DB }, NOW);

    expect(res).toEqual({ disabled: 4, purged: 1 });
    for (const id of [neverRead3d1m, neverRead3d, read30d, read31d]) {
      expect(await state(id)).toEqual({
        status: "paused",
        disabled_at: NOW,
        updated_at: NOW,
      });
    }
    for (const id of [neverRead2d, read29d, adminNever, adminRead]) {
      expect((await state(id))?.status).toBe("active");
      expect((await state(id))?.disabled_at).toBeNull();
    }
    expect(await state(paused)).toEqual({
      status: "paused",
      disabled_at: 123,
      updated_at: old,
    });
    const { results: left } = await env.DB.prepare(
      `SELECT logical_key FROM reader_watch_admissions ORDER BY logical_key`,
    ).all<{ logical_key: string }>();
    expect(left.map((r) => r.logical_key)).toEqual(["k6", "k7"]);
  });
});
