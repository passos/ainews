// Seed values for the model settings. Migration 0002_seed_model_settings.sql
// writes the same values into `settings`, and tests/db.test.ts checks that
// they match. Runtime code reads `settings` (the admin can change it, #9);
// only scripts/smoke-models.ts reads these constants directly.
//
// No runtime imports here: scripts/smoke-models.ts loads this file in Node.

export type Slot = "judge" | "embed" | "write" | "reason";
export type Channel = "workers_ai" | "gateway";

export interface SlotConfig {
  model: string;
  /** Budget channel the slot is billed on. Set from the smoke results. */
  channel: Channel;
}

/** USD per 1M tokens, which is the same as micro-USD per token. */
export interface Price {
  in: number;
  out: number;
}

export const SETTING_SLOTS = "models.slots";
export const SETTING_PRICES = "models.prices";
export const SETTING_BUDGET_CAPS = "budget.caps";

export const DEFAULT_SLOTS: Record<Slot, SlotConfig> = {
  judge: { model: "typesafe/jev", channel: "workers_ai" },
  embed: { model: "@cf/baai/bge-m3", channel: "workers_ai" },
  write: { model: "google/gemini-3.8-flash", channel: "gateway" },
  reason: { model: "anthropic/claude-sonnet-5.5", channel: "gateway" },
};

/** Read from the model pages on 2026-10-22. */
export const DEFAULT_PRICES: Record<string, Price> = {
  "typesafe/jev": { in: 0.042, out: 0 },
  "@cf/baai/bge-m3": { in: 0.0118, out: 0 },
  "google/gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "anthropic/claude-sonnet-5.5": { in: 2.0, out: 10.0 },
};

/** Micro-USD per channel per day. A cap of 0 rejects every call (fail-closed). */
export const DEFAULT_BUDGET_CAPS: Record<string, number> = {
  workers_ai: 500_000,
  gateway: 1_500_000,
  jina: 0,
};
