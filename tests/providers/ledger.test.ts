import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { settle } from "../../src/providers/budget";
import {
  LEASE_MS,
  abandon,
  acquire,
  complete,
  fail,
  reserveAndMarkSent,
} from "../../src/providers/ledger";
import { TransportHttpError } from "../../src/providers/transport";
import {
  BudgetExceededError,
  CallFailedError,
  CallInProgressError,
  CallUnknownError,
  createModelClient,
} from "../../src/providers/models";
import {
  ENABLED,
  NOW,
  TODAY,
  budgetRow,
  fakeTransport,
  hookBatch,
  ledgerRow,
  resetLedger,
} from "./fakes";

const REQUEST = { system: "s", prompt: "p", maxOutputTokens: 16 };

function client(now = NOW, db: D1Database = env.DB) {
  const transport = fakeTransport();
  const models = createModelClient({
    db,
    transport,
    env: ENABLED,
    now: () => now,
  });
  return { models, transport };
}

/** An `in_flight` row left behind by a caller that went away. */
async function strandedRow(
  key: string,
  leaseExpiresAt: number,
  sentAt: number | null,
  attempt = 1,
  failures = 0,
) {
  await env.DB.prepare(
    `INSERT INTO llm_calls (logical_key, slot, model, channel, status, attempt,
       failures, lease_expires_at, sent_at, created_at, updated_at)
     VALUES (?1, 'write', 'google/gemini-3.8-flash', 'gateway', 'in_flight', ?5,
       ?6, ?2, ?3, ?4, ?4)`,
  )
    .bind(key, leaseExpiresAt, sentAt, NOW - LEASE_MS, attempt, failures)
    .run();
}

async function raiseCap() {
  await env.DB.prepare(
    "UPDATE budgets SET cap_micros = 1000000 WHERE day = ?1 AND channel = 'gateway'",
  )
    .bind(TODAY)
    .run();
}

/** Acquires `key` on the gateway channel at NOW; returns the attempt. */
async function acquired(key: string): Promise<number> {
  const outcome = await acquire(env.DB, {
    logicalKey: key,
    slot: "write",
    model: "google/gemini-3.8-flash",
    channel: "gateway",
    now: NOW,
  });
  if (outcome.kind !== "acquired") throw new Error(outcome.kind);
  return outcome.attempt;
}

function send(key: string, attempt: number, estimatedMicros = 100) {
  return reserveAndMarkSent(env.DB, {
    logicalKey: key,
    attempt,
    now: NOW,
    requestJson: "{}",
    estimatedMicros,
    budgetDay: TODAY,
    channel: "gateway",
    capMicros: 1_000_000,
  });
}

function settled(key: string, attempt: number, actualMicros: number) {
  return settle(env.DB, {
    logicalKey: key,
    attempt,
    day: TODAY,
    channel: "gateway",
    reservedMicros: 100,
    actualMicros,
  });
}

function completed(key: string, attempt: number) {
  return complete(env.DB, {
    logicalKey: key,
    attempt,
    now: NOW,
    responseJson: "{}",
    inputTokens: 1,
    outputTokens: 1,
    costMicros: 40,
  });
}

describe("llm_calls ledger", () => {
  beforeEach(() => resetLedger());

  it("sends one request for two concurrent calls with the same key", async () => {
    const { models, transport } = client();
    const results = await Promise.allSettled([
      models.generateText("write", "same", REQUEST),
      models.generateText("write", "same", REQUEST),
    ]);

    expect(transport.calls.length).toBe(1);
    const first = results.find((r) => r.status === "fulfilled");
    expect(first).toBeDefined();
    for (const result of results) {
      if (result.status === "fulfilled") {
        expect(result.value).toEqual(
          (first as PromiseFulfilledResult<unknown>).value,
        );
      } else {
        expect(result.reason).toBeInstanceOf(CallInProgressError);
      }
    }
  });

  it("takes over an expired lease when the request was never sent", async () => {
    await strandedRow("stale", NOW - 1, null);
    const { models, transport } = client();

    await models.generateText("write", "stale", REQUEST);

    expect(transport.calls.length).toBe(1);
    expect(await ledgerRow("stale")).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  });

  it("does not take over a live lease", async () => {
    await strandedRow("live", NOW + 60_000, null);
    const { models, transport } = client();

    await expect(models.generateText("write", "live", REQUEST)).rejects.toThrow(
      CallInProgressError,
    );
    expect(transport.calls.length).toBe(0);
    expect(await ledgerRow("live")).toMatchObject({ status: "in_flight" });
  });

  it("marks an expired, already sent call unknown and does not resend", async () => {
    await strandedRow("sent", NOW - 1, NOW - LEASE_MS);
    const { models, transport } = client();

    await expect(models.generateText("write", "sent", REQUEST)).rejects.toThrow(
      CallUnknownError,
    );
    expect(transport.calls.length).toBe(0);
    expect(await ledgerRow("sent")).toMatchObject({ status: "unknown" });

    // Stays unknown: later callers do not resend either.
    await expect(models.generateText("write", "sent", REQUEST)).rejects.toThrow(
      CallUnknownError,
    );
    expect(transport.calls.length).toBe(0);
  });

  it("fails a stranded unsent row on its last attempt instead of taking it over", async () => {
    await strandedRow("last", NOW - 1, null, 3, 2);
    const { models, transport } = client();

    await expect(models.generateText("write", "last", REQUEST)).rejects.toThrow(
      CallFailedError,
    );
    expect(transport.calls.length).toBe(0);
    expect(await ledgerRow("last")).toMatchObject({
      status: "failed",
      attempt: 3,
      failures: 3,
    });
  });

  it("marks the row failed when the reserve batch fails before sending", async () => {
    const db = hookBatch(async (n, run) => {
      if (n === 2) throw new Error("worker killed");
      return run();
    });
    const { models, transport } = client(NOW, db);

    await expect(
      models.generateText("write", "killed", REQUEST),
    ).rejects.toThrow("worker killed");
    expect(transport.calls.length).toBe(0);
    expect(await ledgerRow("killed")).toMatchObject({
      status: "failed",
      attempt: 1,
      sent_at: null,
    });
    expect(await budgetRow("gateway")).toMatchObject({
      reserved_micros: 0,
      spent_micros: 0,
    });

    // Not stuck: the next call retries at once.
    const retry = client();
    await retry.models.generateText("write", "killed", REQUEST);
    expect(retry.transport.calls.length).toBe(1);
    expect(await ledgerRow("killed")).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  });

  it("uses the attempt its own acquire took, not one read later", async () => {
    // Someone takes the row over right after our acquire commits.
    const db = hookBatch(async (n, run) => {
      const results = await run();
      if (n === 1) {
        await env.DB.prepare(
          "UPDATE llm_calls SET attempt = attempt + 1 WHERE logical_key = 'race'",
        ).run();
      }
      return results;
    });
    const { models, transport } = client(NOW, db);

    await expect(models.generateText("write", "race", REQUEST)).rejects.toThrow(
      CallInProgressError,
    );
    expect(transport.calls.length).toBe(0);
    expect(await budgetRow("gateway")).toMatchObject({ reserved_micros: 0 });
    expect(await ledgerRow("race")).toMatchObject({
      status: "in_flight",
      attempt: 2,
      sent_at: null,
    });
  });

  it("reserves and marks sent in one step", async () => {
    const attempt = await acquired("both");
    expect(await send("both", attempt)).toBe("sent");
    expect(await budgetRow("gateway")).toMatchObject({ reserved_micros: 100 });
    expect(await ledgerRow("both")).toMatchObject({
      status: "in_flight",
      sent_at: NOW,
      estimated_micros: 100,
      budget_day: TODAY,
    });
    // The same attempt cannot reserve twice.
    expect(await send("both", attempt)).toBe("lost");
    expect(await budgetRow("gateway")).toMatchObject({ reserved_micros: 100 });
  });

  it("does not mark the row sent when the budget cannot cover it", async () => {
    await resetLedger(99);
    const attempt = await acquired("short");
    expect(await send("short", attempt)).toBe("over_budget");
    expect(await budgetRow("gateway")).toMatchObject({ reserved_micros: 0 });
    expect(await ledgerRow("short")).toMatchObject({
      status: "failed",
      attempt: 1,
      failures: 0,
      sent_at: null,
      error: "budget_exceeded",
    });
  });

  it("reserves nothing when the row was taken over", async () => {
    await strandedRow("taken", NOW + 60_000, null, 2);
    expect(await send("taken", 1)).toBe("lost");
    expect(await budgetRow("gateway")).toMatchObject({ reserved_micros: 0 });
    expect(await ledgerRow("taken")).toMatchObject({
      status: "in_flight",
      attempt: 2,
      sent_at: null,
    });
  });

  it("settles the same result only once", async () => {
    const attempt = await acquired("twice");
    await send("twice", attempt);

    for (let i = 0; i < 2; i++) {
      await env.DB.batch([
        settled("twice", attempt, 40),
        completed("twice", attempt),
      ]);
    }
    expect(await budgetRow("gateway")).toMatchObject({
      reserved_micros: 0,
      spent_micros: 40,
    });
    expect(await ledgerRow("twice")).toMatchObject({ status: "completed" });
  });

  it("changes nothing when every batch is delivered twice", async () => {
    const db = hookBatch(async (_, run) => {
      const results = await run();
      await run();
      return results;
    });
    const { models, transport } = client(NOW, db);

    await models.generateText("write", "replay", REQUEST);
    expect(transport.calls.length).toBe(1);
    // 8 prompt + 94 thinking tokens at the seeded Gemini price, once.
    expect(await budgetRow("gateway")).toMatchObject({
      reserved_micros: 0,
      spent_micros: 359,
    });
    expect(await ledgerRow("replay")).toMatchObject({
      status: "completed",
      cost_micros: 359,
    });
  });

  it("ignores a late result for a row that already ended", async () => {
    const attempt = await acquired("late");
    await send("late", attempt);
    await env.DB.batch([
      settled("late", attempt, 100),
      fail(env.DB, {
        logicalKey: "late",
        attempt,
        now: NOW,
        error: "timeout",
        responseJson: null,
        costMicros: 100,
      }),
    ]);
    const before = await budgetRow("gateway");
    expect(before).toMatchObject({ reserved_micros: 0, spent_micros: 100 });

    await env.DB.batch([
      settled("late", attempt, 40),
      completed("late", attempt),
    ]);
    expect(await budgetRow("gateway")).toEqual(before);
    expect(await ledgerRow("late")).toMatchObject({ status: "failed" });
  });

  it("still acquires a key after three budget rejections: attempt 4, failures 0", async () => {
    await resetLedger(0);
    const { models, transport } = client();
    for (let i = 0; i < 3; i++) {
      await expect(
        models.generateText("write", "poor", REQUEST),
      ).rejects.toThrow(BudgetExceededError);
    }
    expect(transport.calls.length).toBe(0);
    await raiseCap();

    await models.generateText("write", "poor", REQUEST);
    expect(transport.calls.length).toBe(1);
    expect(await ledgerRow("poor")).toMatchObject({
      status: "completed",
      attempt: 4,
      failures: 0,
    });
  });

  it("a stale holder's abandon does not touch the next holder's lease", async () => {
    await resetLedger(0);
    // A: attempt 1, refused by the budget.
    const a = await acquired("ab");
    expect(a).toBe(1);
    expect(await send("ab", a)).toBe("over_budget");
    // B takes the key next and gets a new attempt number.
    const b = await acquired("ab");
    expect(b).toBe(2);
    // A, not knowing its batch committed, gives up on attempt 1.
    const stale = await abandon(env.DB, {
      logicalKey: "ab",
      attempt: a,
      now: NOW,
      error: "lost the response",
    }).run();
    expect(stale.meta.changes).toBe(0);
    expect(await ledgerRow("ab")).toMatchObject({
      status: "in_flight",
      attempt: 2,
      failures: 0,
    });

    await raiseCap();
    expect(await send("ab", b)).toBe("sent");
  });

  it("throws CallFailedError after three real failures; a budget rejection does not count", async () => {
    await resetLedger(0);
    const transport = fakeTransport(() => {
      throw new TransportHttpError(502, "bad gateway");
    });
    const models = createModelClient({
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });
    await expect(models.generateText("write", "bad", REQUEST)).rejects.toThrow(
      BudgetExceededError,
    );
    await raiseCap();
    for (let i = 0; i < 3; i++) {
      await expect(
        models.generateText("write", "bad", REQUEST),
      ).rejects.toThrow(TransportHttpError);
    }

    await expect(models.generateText("write", "bad", REQUEST)).rejects.toThrow(
      CallFailedError,
    );
    expect(transport.calls.length).toBe(3);
    expect(await ledgerRow("bad")).toMatchObject({
      status: "failed",
      attempt: 4,
      failures: 3,
    });
  });
});
