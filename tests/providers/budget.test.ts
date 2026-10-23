import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { costMicros } from "../../src/providers/budget";
import { DEFAULT_PRICES } from "../../src/providers/defaults";
import {
  BudgetExceededError,
  createModelClient,
} from "../../src/providers/models";
import { googleResponse } from "./fixtures";
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

describe("budget reservation", () => {
  beforeEach(() => resetLedger(0));

  it("does not call when the cap cannot cover the estimate, then succeeds after a raise", async () => {
    const transport = fakeTransport();
    const models = createModelClient({
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });

    await expect(models.generateText("write", "k", REQUEST)).rejects.toThrow(
      BudgetExceededError,
    );
    expect(transport.calls.length).toBe(0);
    expect(await budgetRow("gateway")).toEqual({
      cap_micros: 0,
      reserved_micros: 0,
      spent_micros: 0,
    });
    expect(await ledgerRow("k")).toMatchObject({
      status: "failed",
      attempt: 0,
      error: "budget_exceeded",
    });

    await env.DB.prepare(
      "UPDATE budgets SET cap_micros = 1000000 WHERE day = ?1 AND channel = 'gateway'",
    )
      .bind(TODAY)
      .run();

    const result = await models.generateText("write", "k", REQUEST);
    expect(result.text).toBe("OK");
    expect(transport.calls.length).toBe(1);

    // 8 prompt tokens, 94 thinking (output) tokens, at the seeded Gemini price.
    const { promptTokenCount, thoughtsTokenCount } =
      googleResponse.usageMetadata;
    const price = DEFAULT_PRICES["google/gemini-3.8-flash"];
    const spent = costMicros(price, promptTokenCount, thoughtsTokenCount);
    expect(spent).toBe(359);
    expect(await budgetRow("gateway")).toEqual({
      cap_micros: 1_000_000,
      reserved_micros: 0,
      spent_micros: spent,
    });
    expect(await ledgerRow("k")).toMatchObject({
      status: "completed",
      attempt: 1,
      cost_micros: spent,
    });
  });

  it("computes cost in integers: 1,500 Jev input tokens cost 63", () => {
    expect(costMicros(DEFAULT_PRICES["typesafe/jev"], 1_500, 0)).toBe(63);
    // One rounding at the end, up: 8 * 750,000 + 94 * 3,750,000 = 358.5.
    expect(costMicros(DEFAULT_PRICES["google/gemini-3.8-flash"], 8, 94)).toBe(
      359,
    );
  });
});
