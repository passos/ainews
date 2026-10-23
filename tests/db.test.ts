import { env } from "cloudflare:workers";
import { asc } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  DEFAULT_BUDGET_CAPS,
  DEFAULT_PRICES,
  DEFAULT_SLOTS,
  SETTING_BUDGET_CAPS,
  SETTING_PRICES,
  SETTING_SLOTS,
} from "../src/providers/defaults";
import { getDb } from "../src/server/db/client";
import { settings } from "../src/server/db/schema";

it("migrations seed the three model settings", async () => {
  const rows = await getDb(env.DB)
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .orderBy(asc(settings.key));

  expect(rows.map((r) => r.key)).toEqual([
    SETTING_BUDGET_CAPS,
    SETTING_PRICES,
    SETTING_SLOTS,
  ]);
  const values = Object.fromEntries(
    rows.map((r) => [r.key, JSON.parse(r.value)]),
  );
  expect(values[SETTING_SLOTS]).toEqual(DEFAULT_SLOTS);
  expect(values[SETTING_PRICES]).toEqual(DEFAULT_PRICES);
  // Integer micro-USD per 1M tokens: $0.042/1M.
  expect(values[SETTING_PRICES]["typesafe/jev"]).toEqual({
    in: 42_000,
    out: 0,
  });
  expect(values[SETTING_BUDGET_CAPS]).toEqual({
    workers_ai: 100_000,
    gateway: 1_900_000,
    jina: 0,
  });
  expect(values[SETTING_BUDGET_CAPS]).toEqual(DEFAULT_BUDGET_CAPS);
});

it("migrations create the core tables", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
  ).all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual([
    "analyses",
    "articles",
    "budgets",
    "corrections",
    "event_articles",
    "event_artifacts",
    "events",
    "industries",
    "llm_calls",
    "reviews",
    "settings",
    "sources",
  ]);
});
