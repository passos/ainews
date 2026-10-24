import { env } from "cloudflare:workers";
import { asc } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
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
import reasonMigration from "../drizzle/migrations/0009_reason_slot_gemini.sql?raw";

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

// Run the statements of migration 0009 against the settings row, as a deploy would.
async function runReasonMigration() {
  for (const statement of reasonMigration.split("--> statement-breakpoint")) {
    await env.DB.prepare(statement).run();
  }
}

async function setReasonModel(model: string) {
  await env.DB.prepare(
    "UPDATE settings SET value = json_set(value, '$.reason.model', ?) WHERE key = ?",
  )
    .bind(model, SETTING_SLOTS)
    .run();
}

async function readReasonModel() {
  const row = await env.DB.prepare(
    "SELECT json_extract(value, '$.reason.model') AS model FROM settings WHERE key = ?",
  )
    .bind(SETTING_SLOTS)
    .first<{ model: string }>();
  return row?.model;
}

// The tests below change the settings row; put the seed value back.
afterEach(() => setReasonModel(DEFAULT_SLOTS.reason.model));

it("migrations seed the reason slot with Gemini 3.8 Flash", async () => {
  expect(await readReasonModel()).toBe("google/gemini-3.8-flash");
  expect(DEFAULT_SLOTS.reason.model).toBe("google/gemini-3.8-flash");
});

it("migration 0009 rewrites the old Sonnet seed value", async () => {
  await setReasonModel("anthropic/claude-sonnet-5.5");
  await runReasonMigration();
  expect(await readReasonModel()).toBe("google/gemini-3.8-flash");
});

it("migration 0009 keeps a reason model that was set by hand", async () => {
  await setReasonModel("openai/gpt-6-luna");
  await runReasonMigration();
  expect(await readReasonModel()).toBe("openai/gpt-6-luna");
});

it("migrations create the core tables", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
  ).all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual([
    "analyses",
    "article_sightings",
    "articles",
    "budgets",
    "corrections",
    "event_articles",
    "event_artifacts",
    "events",
    "fetch_hosts",
    "industries",
    "llm_calls",
    "reviews",
    "settings",
    "sources",
  ]);
});

it("the #5 rebuild of articles keeps its indexes and foreign keys", async () => {
  const { results: indexes } = await env.DB.prepare(
    "PRAGMA index_list(articles)",
  ).all<{ name: string; unique: number }>();
  expect(indexes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "articles_canonical_url_unique",
        unique: 1,
      }),
      expect.objectContaining({ name: "articles_stage_idx", unique: 0 }),
    ]),
  );
  const { results: cols } = await env.DB.prepare(
    "PRAGMA index_info(articles_canonical_url_unique)",
  ).all<{ name: string }>();
  expect(cols.map((c) => c.name)).toEqual(["canonical_url"]);

  for (const table of [
    "analyses",
    "reviews",
    "event_articles",
    "article_sightings",
  ]) {
    const { results } = await env.DB.prepare(
      `PRAGMA foreign_key_list(${table})`,
    ).all<{ table: string; from: string }>();
    expect(results).toContainEqual(
      expect.objectContaining({ table: "articles", from: "article_id" }),
    );
  }
  const { results: articleFks } = await env.DB.prepare(
    "PRAGMA foreign_key_list(articles)",
  ).all<{ table: string; from: string }>();
  expect(articleFks.map((f) => `${f.from}->${f.table}`).sort()).toEqual([
    "industry_id->industries",
    "source_id->sources",
  ]);
  const { results: sourceIdx } = await env.DB.prepare(
    "PRAGMA index_list(sources)",
  ).all<{ name: string; unique: number }>();
  expect(sourceIdx).toContainEqual(
    expect.objectContaining({
      name: "sources_industry_feed_unique",
      unique: 1,
    }),
  );
});

it("articles.stage accepts dropped and rejects unknown stages", async () => {
  const [industry] = (
    await env.DB.prepare(
      "INSERT INTO industries (slug, name, created_at) VALUES ('stage-test', 'x', 0) RETURNING id",
    ).all<{ id: number }>()
  ).results;
  const source = await env.DB.prepare(
    "INSERT INTO sources (industry_id, feed_url, kind, created_at) VALUES (?1, 'https://s/', 'rss', 0) RETURNING id",
  )
    .bind(industry.id)
    .first<{ id: number }>();
  const insert = (stage: string, url: string) =>
    env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title,
         fetched_at, stage, stage_updated_at) VALUES (?1, ?2, ?3, ?3, 't', 0, ?4, 0)`,
    )
      .bind(source!.id, industry.id, url, stage)
      .run();
  await insert("dropped", "https://a/1");
  await expect(insert("bogus", "https://a/2")).rejects.toThrow(/CHECK/);
  await expect(
    env.DB.prepare("UPDATE sources SET paused_reason = 'bored' WHERE id = ?1")
      .bind(source!.id)
      .run(),
  ).rejects.toThrow(/CHECK/);
});
