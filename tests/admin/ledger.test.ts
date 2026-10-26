import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  getBudgetSummary,
  reconcileUnknownCall,
  updateDailyCap,
} from "../../src/server/admin/ops";
import { TIER_LABELS } from "../../src/providers/tiers";
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

  it("creates today's budget row when updating cap if it did not exist yet", async () => {
    const freshDay = "2026-12-31";
    await updateDailyCap(
      env.DB,
      { channel: "gateway", capMicros: 3000000 },
      freshDay,
    );

    const row = await env.DB.prepare(
      "SELECT cap_micros, reserved_micros, spent_micros FROM budgets WHERE day = ?1 AND channel = 'gateway'",
    )
      .bind(freshDay)
      .first<{
        cap_micros: number;
        reserved_micros: number;
        spent_micros: number;
      }>();
    expect(row).toEqual({
      cap_micros: 3000000,
      reserved_micros: 0,
      spent_micros: 0,
    });
  });

  it("updates settings json keys atomically without overwriting other channels", async () => {
    await updateDailyCap(
      env.DB,
      { channel: "workers_ai", capMicros: 150000 },
      "2026-10-24",
    );
    await updateDailyCap(
      env.DB,
      { channel: "gateway", capMicros: 2000000 },
      "2026-10-24",
    );

    const setting = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'budget.caps'",
    ).first<{ value: string }>();
    const caps = JSON.parse(setting?.value ?? "{}");
    expect(caps.workers_ai).toBe(150000);
    expect(caps.gateway).toBe(2000000);
  });
});

describe("getBudgetSummary gateway spend by tier (#116)", () => {
  const DAY = "2020-01-01";

  async function call(
    key: string,
    o: {
      day?: string;
      channel?: string;
      status: string;
      tier: number | null;
      sent?: boolean;
      est?: number | null;
      cost?: number | null;
    },
  ) {
    await env.DB.prepare(
      `INSERT INTO llm_calls (logical_key, slot, model, channel, status, tier,
         sent_at, estimated_micros, cost_micros, budget_day, created_at, updated_at)
       VALUES (?1, 'write', 'm', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0)`,
    )
      .bind(
        key,
        o.channel ?? "gateway",
        o.status,
        o.tier,
        o.sent === false ? null : 1,
        o.est ?? null,
        o.cost ?? null,
        o.day ?? DAY,
      )
      .run();
  }

  it("sums llm_calls by tier: spent = completed/failed cost, reserved = sent in_flight/unknown estimate", async () => {
    await call("r11-a", { status: "completed", tier: 1, est: 120, cost: 100 });
    await call("r11-b", { status: "failed", tier: 1, est: 40, cost: 30 });
    await call("r11-c", {
      status: "failed",
      tier: 1,
      sent: false,
      est: 50,
    });
    // Retried after a billed failure: the stale cost is not spent.
    await call("r11-d", {
      status: "in_flight",
      tier: 2,
      est: 500,
      cost: 77,
    });
    await call("r11-e", { status: "in_flight", tier: 2, sent: false });
    await call("r11-f", { status: "unknown", tier: 2, est: 700 });
    await call("r11-g", { status: "pending", tier: 5, sent: false });
    await call("r11-h", { status: "completed", tier: null, cost: 9 });
    // Not counted: another day, another channel.
    await call("r11-x", {
      day: "2020-01-02",
      status: "completed",
      tier: 1,
      cost: 1000,
    });
    await call("r11-y", {
      channel: "workers_ai",
      status: "completed",
      tier: 1,
      cost: 5000,
    });
    await call("r11-z", {
      channel: "workers_ai",
      status: "in_flight",
      tier: 2,
      est: 5000,
    });

    const summary = await getBudgetSummary(env.DB, DAY);
    expect(summary.tierReserves).toBeNull();
    expect(summary.tierReservesError).toBeNull();
    expect(summary.tiers).toEqual([
      {
        tier: 1,
        label: TIER_LABELS[1],
        reserveMicros: 500_000,
        floorMicros: 0,
        spentMicros: 130,
        reservedMicros: 0,
        calls: 3,
      },
      {
        tier: 2,
        label: TIER_LABELS[2],
        reserveMicros: 400_000,
        floorMicros: 500_000,
        spentMicros: 0,
        reservedMicros: 1200,
        calls: 3,
      },
      {
        tier: 5,
        label: TIER_LABELS[5],
        reserveMicros: null,
        floorMicros: 1_200_000,
        spentMicros: 0,
        reservedMicros: 0,
        calls: 1,
      },
      {
        tier: null,
        label: "untiered",
        reserveMicros: null,
        floorMicros: null,
        spentMicros: 9,
        reservedMicros: 0,
        calls: 1,
      },
    ]);
  });

  it("uses the stored reserves when budget.tier_reserves is set", async () => {
    const day = "2020-02-01";
    await call("r11-s", { day, status: "completed", tier: 3, cost: 7 });
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('budget.tier_reserves', '{"1":10,"2":20,"3":30,"4":40}', 0)`,
    ).run();
    try {
      const summary = await getBudgetSummary(env.DB, day);
      expect(summary.tierReserves).toEqual({ 1: 10, 2: 20, 3: 30, 4: 40 });
      expect(summary.tiers).toEqual([
        {
          tier: 3,
          label: TIER_LABELS[3],
          reserveMicros: 30,
          floorMicros: 30,
          spentMicros: 7,
          reservedMicros: 0,
          calls: 1,
        },
      ]);
    } finally {
      await env.DB.prepare(
        "DELETE FROM settings WHERE key = 'budget.tier_reserves'",
      ).run();
    }
  });

  it("reports a malformed budget.tier_reserves instead of computing floors", async () => {
    const day = "2020-03-01";
    await call("r11-m", { day, status: "completed", tier: 2, cost: 5 });
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('budget.tier_reserves', '{"1":-1}', 0)`,
    ).run();
    try {
      const summary = await getBudgetSummary(env.DB, day);
      expect(summary.tierReserves).toBeNull();
      expect(summary.tierReservesError).toEqual(expect.any(String));
      expect(summary.tiers).toEqual([
        {
          tier: 2,
          label: TIER_LABELS[2],
          reserveMicros: null,
          floorMicros: null,
          spentMicros: 5,
          reservedMicros: 0,
          calls: 1,
        },
      ]);
    } finally {
      await env.DB.prepare(
        "DELETE FROM settings WHERE key = 'budget.tier_reserves'",
      ).run();
    }
  });
});
