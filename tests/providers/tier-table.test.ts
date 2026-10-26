// The tier table and floor arithmetic of the gateway budget tiers (#116).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_RESERVES } from "../../src/providers/defaults";
import { acquire, reserveAndMarkSent } from "../../src/providers/ledger";
import { CALL_TIERS, tierFloorMicros } from "../../src/providers/tiers";
import { NOW, TODAY, budgetRow, resetLedger } from "./fakes";

describe("tier table", () => {
  it("pins the default reserves and the caller tiers", () => {
    expect(DEFAULT_TIER_RESERVES).toEqual({
      "1": 500_000,
      "2": 400_000,
      "3": 200_000,
      "4": 100_000,
    });
    expect(CALL_TIERS).toEqual({
      analyze: 1,
      body: 1,
      group: 1,
      evidence: 3,
      adminAsk: 3,
      watch: 4,
      digest: 5,
      discover: 5,
    });
  });

  it("floor(N) sums the reserves of the strictly earlier tiers", () => {
    const floors = ([1, 2, 3, 4, 5] as const).map((t) =>
      tierFloorMicros(DEFAULT_TIER_RESERVES, t),
    );
    expect(floors).toEqual([0, 500_000, 900_000, 1_100_000, 1_200_000]);
  });

  it("rejects a reserve that is not a non-negative safe integer", () => {
    expect(() =>
      tierFloorMicros({ "1": -1, "2": 0, "3": 0, "4": 0 }, 5),
    ).toThrow(RangeError);
    expect(() =>
      tierFloorMicros({ "1": 0.5, "2": 0, "3": 0, "4": 0 }, 2),
    ).toThrow(RangeError);
  });

  it("tier 5 runs at the start of the budget day with the default reserves", async () => {
    // 12,816 micro-USD: the largest digest estimate seen in production.
    await resetLedger(1_900_000);
    const outcome = await acquire(env.DB, {
      logicalKey: "digest-start",
      slot: "write",
      model: "google/gemini-3.8-flash",
      channel: "gateway",
      now: NOW,
      tier: 5,
    });
    if (outcome.kind !== "acquired") throw new Error(outcome.kind);
    const sent = await reserveAndMarkSent(env.DB, {
      logicalKey: "digest-start",
      attempt: outcome.attempt,
      now: NOW,
      requestJson: "{}",
      estimatedMicros: 12_816,
      budgetDay: TODAY,
      channel: "gateway",
      capMicros: 1_900_000,
      floorMicros: tierFloorMicros(DEFAULT_TIER_RESERVES, 5),
    });
    expect(sent).toBe("sent");
    expect(await budgetRow("gateway")).toEqual({
      cap_micros: 1_900_000,
      reserved_micros: 12_816,
      spent_micros: 0,
    });
  });
});
