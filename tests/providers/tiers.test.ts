// Gateway budget tiers (#116). Reserves are seeded as literal JSON so these
// tests do not depend on src/providers/tiers.ts.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEASE_MS } from "../../src/providers/ledger";
import {
  BudgetExceededError,
  createModelClient,
} from "../../src/providers/models";
import {
  ENABLED,
  NOW,
  TODAY,
  budgetRow,
  fakeTransport,
  ledgerRow,
  resetLedger,
} from "./fakes";

const REQUEST = { system: "s", prompt: "p", maxOutputTokens: 16 };

function client(tier: 1 | 2 | 3 | 4 | 5) {
  const transport = fakeTransport();
  const models = createModelClient({
    db: env.DB,
    transport,
    env: ENABLED,
    now: () => NOW,
    tier,
  });
  return { models, transport };
}

async function setReserves(json: string) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('budget.tier_reserves', ?1, 0)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  )
    .bind(json)
    .run();
}

async function setSpent(channel: string, spentMicros: number) {
  await env.DB.prepare(
    `UPDATE budgets SET spent_micros = ?3, reserved_micros = 0
     WHERE day = ?1 AND channel = ?2`,
  )
    .bind(TODAY, channel, spentMicros)
    .run();
}

async function tierRow(key: string) {
  return env.DB.prepare(
    "SELECT status, error, failures, tier FROM llm_calls WHERE logical_key = ?1",
  )
    .bind(key)
    .first<{
      status: string;
      error: string | null;
      failures: number;
      tier: number | null;
    }>();
}

/** The reservation of `key`'s completed call: the estimate of REQUEST. */
async function estimateOf(key: string): Promise<number> {
  const row = await ledgerRow(key);
  const est = row?.estimated_micros;
  if (typeof est !== "number" || est <= 0) throw new Error(`no estimate`);
  return est;
}

afterEach(async () => {
  await env.DB.prepare(
    "DELETE FROM settings WHERE key = 'budget.tier_reserves'",
  ).run();
});

describe("gateway budget tiers", () => {
  beforeEach(() => resetLedger(1_900_000));

  it("tier 5 is refused when only tier 1's reserve remains; tier 1 still passes", async () => {
    await setReserves('{"1":500000,"2":0,"3":0,"4":0}');
    await setSpent("gateway", 1_400_000);

    const t5 = client(5);
    const error = await t5.models
      .generateText("write", "t5", REQUEST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as { tier?: number }).tier).toBe(5);
    expect(t5.transport.calls.length).toBe(0);
    expect(await tierRow("t5")).toEqual({
      status: "failed",
      error: "budget_exceeded",
      failures: 0,
      tier: 5,
    });
    expect(await budgetRow("gateway")).toEqual({
      cap_micros: 1_900_000,
      reserved_micros: 0,
      spent_micros: 1_400_000,
    });

    const t1 = client(1);
    const result = await t1.models.generateText("write", "t1", REQUEST);
    expect(result.text).toBe("OK");
    expect(t1.transport.calls.length).toBe(1);
    const after = await budgetRow("gateway");
    expect(after?.reserved_micros).toBe(0);
    expect(after?.spent_micros).toBeGreaterThan(1_400_000);
    expect(await tierRow("t1")).toMatchObject({ status: "completed", tier: 1 });
  });

  it("boundary: tier 5 passes at spent + est + floor == cap and is refused 1 micro-USD above", async () => {
    // floor(5) = 100 + 200 + 300 + 400 = 1000.
    await setReserves('{"1":100,"2":200,"3":300,"4":400}');
    await client(5).models.generateText("write", "probe", REQUEST);
    const est = await estimateOf("probe");

    await setSpent("gateway", 1_900_000 - est - 1000);
    const pass = client(5);
    await expect(
      pass.models.generateText("write", "edge-pass", REQUEST),
    ).resolves.toMatchObject({ text: "OK" });
    expect(await ledgerRow("edge-pass")).toMatchObject({
      estimated_micros: est,
    });

    await setSpent("gateway", 1_900_000 - est - 1000 + 1);
    const refused = client(5);
    await expect(
      refused.models.generateText("write", "edge-fail", REQUEST),
    ).rejects.toThrow(BudgetExceededError);
    expect(refused.transport.calls.length).toBe(0);
  });

  it("the floor does not apply outside gateway: tier 5 embed at spent = cap - est passes", async () => {
    await setReserves('{"1":100,"2":200,"3":300,"4":400}');
    await client(5).models.embed("e-probe", ["x"]);
    const est = await estimateOf("e-probe");

    await setSpent("workers_ai", 1_900_000 - est);
    const t5 = client(5);
    await expect(t5.models.embed("e-edge", ["x"])).resolves.toBeDefined();
    expect(t5.transport.calls.length).toBe(1);
    expect(await tierRow("e-edge")).toMatchObject({
      status: "completed",
      tier: 5,
    });
  });

  it("llm_calls.tier is the client's tier, on insert and on takeover", async () => {
    await client(4).models.generateText("write", "r4-new", REQUEST);
    expect(await tierRow("r4-new")).toMatchObject({
      status: "completed",
      tier: 4,
    });

    // A stranded, unsent lease (no tier recorded) taken over by tier 3.
    await env.DB.prepare(
      `INSERT INTO llm_calls (logical_key, slot, model, channel, status, attempt,
         failures, lease_expires_at, sent_at, created_at, updated_at)
       VALUES ('r4-take', 'write', 'google/gemini-3.8-flash', 'gateway',
         'in_flight', 1, 0, ?1, NULL, ?2, ?2)`,
    )
      .bind(NOW - 1, NOW - LEASE_MS)
      .run();
    await client(3).models.generateText("write", "r4-take", REQUEST);
    expect(await tierRow("r4-take")).toMatchObject({
      status: "completed",
      tier: 3,
    });

    // Refused at tier 5, then retried by a tier 1 client.
    await setReserves('{"1":500000,"2":0,"3":0,"4":0}');
    await setSpent("gateway", 1_400_000);
    await expect(
      client(5).models.generateText("write", "r4-retry", REQUEST),
    ).rejects.toThrow(BudgetExceededError);
    expect(await tierRow("r4-retry")).toMatchObject({ tier: 5 });
    await client(1).models.generateText("write", "r4-retry", REQUEST);
    expect(await tierRow("r4-retry")).toMatchObject({
      status: "completed",
      tier: 1,
    });
  });

  it("without budget.tier_reserves the default reserves apply (floor(5) = 1,200,000)", async () => {
    await client(1).models.generateText("write", "a-probe", REQUEST);
    const est = await estimateOf("a-probe");

    // Tier 1 has no floor: it can spend up to the cap.
    await setSpent("gateway", 1_900_000 - est);
    await expect(
      client(1).models.generateText("write", "a-t1", REQUEST),
    ).resolves.toMatchObject({ text: "OK" });

    await setSpent("gateway", 1_900_000 - est);
    await expect(
      client(5).models.generateText("write", "a-t5-refused", REQUEST),
    ).rejects.toThrow(BudgetExceededError);

    // Default reserves 500,000 / 400,000 / 200,000 / 100,000.
    await setSpent("gateway", 1_900_000 - est - 1_200_000);
    await expect(
      client(5).models.generateText("write", "a-t5-pass", REQUEST),
    ).resolves.toMatchObject({ text: "OK" });
  });

  it.each([
    ["a negative reserve", '{"1":-1,"2":0,"3":0,"4":0}'],
    ["a fractional reserve", '{"1":1.5,"2":0,"3":0,"4":0}'],
    ["a missing tier", '{"1":0,"2":0,"3":0}'],
    ["an extra key", '{"1":0,"2":0,"3":0,"4":0,"5":0}'],
    ["a string reserve", '{"1":"0","2":0,"3":0,"4":0}'],
    ["an array", "[0,0,0,0]"],
  ])(
    "a malformed budget.tier_reserves (%s) throws before acquire and leaves no row",
    async (_, json) => {
      await setReserves(json);
      const t1 = client(1);
      await expect(
        t1.models.generateText("write", "bad-reserves", REQUEST),
      ).rejects.toThrow();
      expect(t1.transport.calls.length).toBe(0);
      const row = await env.DB.prepare(
        "SELECT count(*) AS n FROM llm_calls WHERE logical_key = ?1",
      )
        .bind("bad-reserves")
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    },
  );
});
