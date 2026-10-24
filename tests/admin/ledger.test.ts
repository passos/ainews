import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  reconcileUnknownCall,
  updateDailyCap,
} from "../../src/server/admin/ops";
import { utcDay } from "../../src/providers/budget";

describe("ledger and budget admin operations", () => {
  it("reconciles unknown calls, settling budget atomically and rejecting non-unknown with 409", async () => {
    const today = utcDay(Date.now());
    // Create a budget row
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
       VALUES (?1, 'gateway', 1900000, 50000, 100000)
       ON CONFLICT (day, channel) DO UPDATE SET reserved_micros = 50000, spent_micros = 100000`,
    )
      .bind(today)
      .run();

    // Create an unknown llm_call
    const callRes = await env.DB.prepare(
      `INSERT INTO llm_calls (logical_key, slot, model, channel, status, estimated_micros, budget_day, created_at, updated_at)
       VALUES ('test-key-unknown-1', 'write', 'google/gemini-3.8-flash', 'gateway', 'unknown', 50000, ?1, 0, 0)
       RETURNING id`,
    )
      .bind(today)
      .first<{ id: number }>();
    const callId = callRes!.id;

    // Reconcile: unknown -> completed with actual cost 10,000 micros ($0.01)
    await reconcileUnknownCall(env.DB, {
      callId,
      status: "completed",
      costMicros: 10000,
    });

    // Verify budget updated: reserved_micros decreased by 50,000 (now 0), spent_micros increased by 10,000 (now 110,000)
    const budget = await env.DB.prepare(
      "SELECT reserved_micros, spent_micros FROM budgets WHERE day = ?1 AND channel = 'gateway'",
    )
      .bind(today)
      .first<{ reserved_micros: number; spent_micros: number }>();
    expect(budget!.reserved_micros).toBe(0);
    expect(budget!.spent_micros).toBe(110000);

    // Reconcile again: should return 409 and not change budget
    let error: unknown = null;
    try {
      await reconcileUnknownCall(env.DB, {
        callId,
        status: "completed",
        costMicros: 20000,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(
      error instanceof Response
        ? error.status
        : (error as { status?: number })?.status,
    ).toBe(409);

    const budgetAfter = await env.DB.prepare(
      "SELECT reserved_micros, spent_micros FROM budgets WHERE day = ?1 AND channel = 'gateway'",
    )
      .bind(today)
      .first<{ reserved_micros: number; spent_micros: number }>();
    expect(budgetAfter!.reserved_micros).toBe(0);
    expect(budgetAfter!.spent_micros).toBe(110000);
  });

  it("updates daily cap in settings and today's budget", async () => {
    const today = utcDay(Date.now());
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
       VALUES (?1, 'workers_ai', 100000, 0, 0)
       ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 100000`,
    )
      .bind(today)
      .run();

    await updateDailyCap(
      env.DB,
      { channel: "workers_ai", capMicros: 250000 },
      today,
    );

    const budget = await env.DB.prepare(
      "SELECT cap_micros FROM budgets WHERE day = ?1 AND channel = 'workers_ai'",
    )
      .bind(today)
      .first<{ cap_micros: number }>();
    expect(budget!.cap_micros).toBe(250000);

    const setting = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'budget.caps'",
    ).first<{ value: string }>();
    const caps = JSON.parse(setting?.value ?? "{}");
    expect(caps.workers_ai).toBe(250000);
  });
});
