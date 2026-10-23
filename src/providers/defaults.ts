// Seed values for the model settings. Migration 0002_seed_model_settings.sql
// writes the same values into `settings`, and tests/db.test.ts checks that
// they match. Runtime code reads `settings` (the admin can change it, #9);
// only scripts/smoke-models.ts reads these constants directly.
//
// No runtime imports here: scripts/smoke-models.ts loads this file in Node.

/** `read`: Jina Reader (fetch ladder rung 3, #6), billed on channel `jina`. */
export type Slot = "judge" | "embed" | "write" | "reason" | "read";
export type Channel = "workers_ai" | "gateway" | "jina";

export interface SlotConfig {
  model: string;
  /** Budget channel the slot is billed on. Set from the smoke results. */
  channel: Channel;
}

/**
 * Micro-USD per 1M tokens, as integers (USD per 1M tokens x 1,000,000), so
 * cost arithmetic stays exact. Example: $0.042/1M is 42_000.
 */
export interface Price {
  in: number;
  out: number;
}

export const SETTING_SLOTS = "models.slots";
export const SETTING_PRICES = "models.prices";
export const SETTING_BUDGET_CAPS = "budget.caps";

export const DEFAULT_SLOTS: Record<Slot, SlotConfig> = {
  judge: { model: "typesafe/jev", channel: "gateway" },
  embed: { model: "@cf/baai/bge-m3", channel: "workers_ai" },
  write: { model: "google/gemini-3.8-flash", channel: "gateway" },
  reason: { model: "anthropic/claude-sonnet-5.5", channel: "gateway" },
  read: { model: "jina/reader", channel: "jina" },
};

/** Read from the model pages on 2026-10-22. */
export const DEFAULT_PRICES: Record<string, Price> = {
  "typesafe/jev": { in: 42_000, out: 0 },
  "@cf/baai/bge-m3": { in: 11_800, out: 0 },
  "google/gemini-3.8-flash": { in: 750_000, out: 3_750_000 },
  "anthropic/claude-sonnet-5.5": { in: 2_000_000, out: 10_000_000 },
  // Assumption: $0.05 per 1M tokens, counted as output (x-usage-tokens).
  // Correct it from the Jina bill.
  "jina/reader": { in: 0, out: 50_000 },
};

/** Micro-USD per channel per day. A cap of 0 rejects every call (fail-closed). */
export const DEFAULT_BUDGET_CAPS: Record<string, number> = {
  workers_ai: 100_000,
  gateway: 1_900_000,
  jina: 0,
};
