// `analyze` messages (#7). Jev and the `write` model are a fake transport
// behind the real model client and ledger; R2 and D1 are the test bindings.
import { Validator } from "@cfworker/json-schema";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeArticle,
  effectivePublishMode,
} from "../../src/pipeline/analyze/analyze";
import type { AnalysisConfig } from "../../src/pipeline/analyze/config";
import { UNTRUSTED } from "../../src/pipeline/analyze/prompts";
import {
  buildAnalysisRequest,
  promptVersion,
} from "../../src/pipeline/analyze/questions";
import type { AnalysisAnswers } from "../../src/pipeline/analyze/score";
import type { IngestMessage } from "../../src/pipeline/messages";
import { runQueue } from "../../src/pipeline/queue";
import { buildJevInput } from "../../src/providers/jev";
import type { JevQuestion } from "../../src/providers/jev";
import {
  choice,
  fakeAnalysisConfig,
  fakeAnswers,
  jevResponse,
} from "../fixtures/analysis/config";
import schemaInput from "../fixtures/jev/schema-input.json?raw";
import { fakeTransport, resetLedger } from "../providers/fakes";
import type { FakeTransport } from "../providers/fakes";
import {
  count,
  fakeQueue,
  MIN,
  NOW,
  pipelineEnv,
  resetPipeline,
  seedArticle,
  seedSource,
} from "./helpers";

const SHA = "a".repeat(64);
const BODY = "# A test article\n\nSomething happened, said the source.";
const ENABLED = { MODEL_CALLS_ENABLED: "true" };
const GOOD_WRITE = JSON.stringify({
  title: "Example Lab releases a test model",
  summary: "Example Lab released a test model. It is a test.",
});
const config = fakeAnalysisConfig();

function googleText(text: string) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  };
}

/** Jev answers `answers`; the write model answers `write` (or throws it). */
function models(
  answers: AnalysisAnswers,
  write: string | Error = GOOD_WRITE,
  onJev?: () => Promise<void>,
): FakeTransport {
  return fakeTransport(async (model) => {
    if (model === "typesafe/jev") {
      await onJev?.();
      return jevResponse(answers);
    }
    if (model.startsWith("google/")) {
      if (write instanceof Error) throw write;
      return googleText(write);
    }
    throw new Error(`unexpected model ${model}`);
  });
}

const jevCalls = (t: FakeTransport) =>
  t.calls.filter((c) => c.model === "typesafe/jev").length;
const writeCalls = (t: FakeTransport) =>
  t.calls.filter((c) => c.model.startsWith("google/")).length;

async function seedIndustryRow(
  slug: string,
  publishMode: "auto" | "review",
  analysis: AnalysisConfig | null = config,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO industries (slug, name, publish_mode, config, created_at)
     VALUES (?1, ?1, ?2, ?3, 0) RETURNING id`,
  )
    .bind(slug, publishMode, JSON.stringify(analysis ? { analysis } : {}))
    .first<{ id: number }>();
  return row!.id;
}

/** A body_ready article whose clock is stale and requeued twice. */
async function seedReady(
  industryId: number,
  opts: { title?: string; stage?: string } = {},
): Promise<number> {
  const sourceId = await seedSource({
    industryId,
    feedUrl: `https://feeds.example/${industryId}`,
  });
  const id = await seedArticle({
    sourceId,
    industryId,
    url: `https://news.example/${industryId}/1`,
    stage: opts.stage ?? "body_ready",
    stageUpdatedAt: NOW - 31 * MIN,
    requeueCount: 2,
    title: opts.title ?? "A test article",
    summary: "Something happened.",
  });
  await env.DB.prepare("UPDATE articles SET body_sha = ?2 WHERE id = ?1")
    .bind(id, SHA)
    .run();
  await env.BODIES.put(`bodies/${id}/${SHA}.md`, BODY);
  return id;
}

async function articleRow(id: number) {
  return env.DB.prepare(
    "SELECT stage, stage_updated_at, requeue_count, body_sha FROM articles WHERE id = ?1",
  )
    .bind(id)
    .first<{
      stage: string;
      stage_updated_at: number;
      requeue_count: number;
      body_sha: string;
    }>();
}

async function analysisRow(id: number) {
  return env.DB.prepare(
    `SELECT prompt_version, scores, content_type, evidence_tags, total_score,
       prefilter_relevant, prefilter_pass, category, noise_kind, selected,
       title_en, summary_en, jev_raw
     FROM analyses WHERE article_id = ?1`,
  )
    .bind(id)
    .first<{
      prompt_version: string;
      scores: string;
      content_type: string;
      evidence_tags: string;
      total_score: number;
      prefilter_relevant: number;
      prefilter_pass: number;
      category: string;
      noise_kind: string;
      selected: number;
      title_en: string | null;
      summary_en: string | null;
      jev_raw: string;
    }>();
}

const reviewRows = (id: number) =>
  env.DB.prepare(
    "SELECT body_sha, decision, reviewer FROM reviews WHERE article_id = ?1",
  )
    .bind(id)
    .all<{ body_sha: string; decision: string; reviewer: string }>()
    .then((r) => r.results);

const run = (
  id: number,
  t: FakeTransport,
  flags: Parameters<typeof pipelineEnv>[1] = ENABLED,
) => analyzeArticle(pipelineEnv(fakeQueue(), flags), id, NOW, { transport: t });

function batch(bodies: IngestMessage[]) {
  const acked: number[] = [];
  const b = {
    queue: "ainews-ingest",
    messages: bodies.map((body, i) => ({
      id: String(i),
      timestamp: new Date(NOW),
      attempts: 1,
      body,
      ack: () => acked.push(i),
      retry: () => {},
    })),
    ackAll: () => {},
    retryAll: () => {},
  };
  return { batch: b as unknown as MessageBatch, acked };
}

beforeEach(async () => {
  await resetPipeline();
  await resetLedger();
});
afterEach(() => vi.restoreAllMocks());

describe("analyzeArticle: selected article", () => {
  it("the same analyze message twice through runQueue: Jev 1, write 1, one analyses row", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config));
    const msg: IngestMessage = { kind: "analyze", articleId: id };
    const { batch: b, acked } = batch([msg, msg]);
    await runQueue(b, pipelineEnv(fakeQueue(), ENABLED), {} as never, {
      transport: t,
    });
    expect(acked).toEqual([0, 1]);
    expect(jevCalls(t)).toBe(1);
    expect(writeCalls(t)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM reviews")).toBe(1);
  });

  it("a lost commit is redone from the ledger: no second model request", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config));
    await run(id, t);
    // As if the commit batch had failed after both model calls completed.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM reviews"),
      env.DB.prepare("DELETE FROM analyses"),
      env.DB.prepare(
        "UPDATE articles SET stage = 'body_ready' WHERE id = ?1",
      ).bind(id),
    ]);
    const again = await run(id, t);
    expect(again).toMatchObject({ status: "ok", stage: "analyzed" });
    expect(jevCalls(t)).toBe(1);
    expect(writeCalls(t)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(1);
    expect((await analysisRow(id))?.summary_en).toBe(
      JSON.parse(GOOD_WRITE).summary,
    );
  });

  it("stores the scores, labels and the English text; the stage write resets the clock", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "review"));
    const t = models(
      fakeAnswers(config, {
        noise: "hype",
        labels: {
          publication_status: choice("preprint", 0.9),
          claim_mode: choice("forecast", 0.4),
        },
      }),
    );
    expect(await run(id, t)).toMatchObject({
      status: "ok",
      stage: "analyzed",
      selected: true,
      total: 88,
      written: true,
      approved: false,
      advanced: true,
    });
    expect(await articleRow(id)).toMatchObject({
      stage: "analyzed",
      stage_updated_at: NOW,
      requeue_count: 0,
    });
    const row = await analysisRow(id);
    expect(row).toMatchObject({
      prompt_version: await promptVersion(config),
      content_type: "report",
      total_score: 88,
      prefilter_relevant: 0.9,
      prefilter_pass: 1,
      category: "alpha",
      noise_kind: "hype",
      selected: 1,
      title_en: JSON.parse(GOOD_WRITE).title,
      summary_en: JSON.parse(GOOD_WRITE).summary,
    });
    expect(JSON.parse(row!.scores)).toEqual({
      sig: 4,
      nov: 10,
      cred: 10,
      reson: 10,
      act: 10,
    });
    // Confidence 0.4 is stored as "uncertain".
    expect(JSON.parse(row!.evidence_tags)).toEqual({
      publication_status: "preprint",
      claim_mode: "uncertain",
    });
    expect(Object.keys(JSON.parse(row!.jev_raw))).toContain("sig");
  });
});

describe("publish mode", () => {
  it("auto industry, valid write: one approved row by 'auto' for the current body_sha", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    expect(await run(id, models(fakeAnswers(config)))).toMatchObject({
      approved: true,
    });
    const current = (await articleRow(id))!.body_sha;
    expect(current).toBe(SHA);
    expect(await reviewRows(id)).toEqual([
      { body_sha: current, decision: "approved", reviewer: "auto" },
    ]);
  });

  it("finance with publish_mode 'auto' is never approved automatically", async () => {
    const id = await seedReady(await seedIndustryRow("finance", "auto"));
    const result = await run(id, models(fakeAnswers(config)));
    expect(result).toMatchObject({
      stage: "analyzed",
      selected: true,
      written: true,
      approved: false,
    });
    expect(await reviewRows(id)).toEqual([]);
    expect(
      effectivePublishMode({ slug: "finance", publish_mode: "auto" }),
    ).toBe("review");
  });

  it("review industry: a selected article gets no approved reviews row", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "review"));
    await run(id, models(fakeAnswers(config)));
    expect((await articleRow(id))?.stage).toBe("analyzed");
    expect(
      await count(
        "SELECT count(*) AS n FROM reviews WHERE article_id = ?1 AND decision = 'approved'",
        id,
      ),
    ).toBe(0);
  });

  it("write returns JSON outside the schema: no summary, analyzed, no auto approval", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const bad = JSON.stringify({ title: "x", summary: "y".repeat(601) });
    const result = await run(id, models(fakeAnswers(config), bad));
    expect(result).toMatchObject({
      stage: "analyzed",
      selected: true,
      written: false,
      approved: false,
    });
    expect(await analysisRow(id)).toMatchObject({
      selected: 1,
      title_en: null,
      summary_en: null,
    });
    expect((await articleRow(id))?.stage).toBe("analyzed");
    expect(await reviewRows(id)).toEqual([]);
  });

  it("write fails at the transport: no summary, analyzed, no auto approval", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    await run(id, models(fakeAnswers(config), new Error("connection lost")));
    expect(await analysisRow(id)).toMatchObject({
      selected: 1,
      summary_en: null,
    });
    expect((await articleRow(id))?.stage).toBe("analyzed");
    expect(await reviewRows(id)).toEqual([]);
  });
});

describe("not selected", () => {
  it("prefilter below the threshold: dropped, no write call, analyses row kept", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config, { relevant: 0.29 }));
    expect(await run(id, t)).toMatchObject({ stage: "dropped" });
    expect(writeCalls(t)).toBe(0);
    expect(await articleRow(id)).toMatchObject({
      stage: "dropped",
      stage_updated_at: NOW,
      requeue_count: 0,
    });
    expect(await analysisRow(id)).toMatchObject({
      prefilter_pass: 0,
      selected: 0,
      summary_en: null,
    });
    expect(await reviewRows(id)).toEqual([]);
  });

  it("total below select: dropped", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const low = { "1": 1 };
    const t = models(
      fakeAnswers(config, {
        dims: { sig: low, nov: low, cred: low, reson: low, act: low },
      }),
    );
    expect(await run(id, t)).toMatchObject({ stage: "dropped", total: 25 });
    expect(writeCalls(t)).toBe(0);
  });
});

describe("no analysis", () => {
  it("MODEL_CALLS_ENABLED not set: no model call, no DB write", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config));
    expect(await run(id, t, {})).toEqual({ status: "disabled" });
    expect(await run(id, t, { MODEL_CALLS_ENABLED: "false" })).toEqual({
      status: "disabled",
    });
    expect(t.calls).toHaveLength(0);
    expect(await articleRow(id)).toMatchObject({
      stage: "body_ready",
      stage_updated_at: NOW - 31 * MIN,
      requeue_count: 2,
    });
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM llm_calls")).toBe(0);
  });

  it("a stage other than body_ready is skipped", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"), {
      stage: "collected",
    });
    const t = models(fakeAnswers(config));
    expect(await run(id, t)).toEqual({ status: "skipped" });
    expect(t.calls).toHaveLength(0);
  });

  it("the stage moved during the call: the stage write does not apply", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config), GOOD_WRITE, async () => {
      await env.DB.prepare(
        "UPDATE articles SET stage = 'grouped', requeue_count = 1 WHERE id = ?1",
      )
        .bind(id)
        .run();
    });
    expect(await run(id, t)).toMatchObject({
      status: "ok",
      advanced: false,
      approved: false,
    });
    expect(await articleRow(id)).toMatchObject({
      stage: "grouped",
      requeue_count: 1,
    });
    expect(await reviewRows(id)).toEqual([]);
  });

  it("another delivery already analysed the article: this one writes no approval", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    // The other delivery won with its own stage_updated_at; its reviews row
    // is not there yet.
    const t = models(fakeAnswers(config), GOOD_WRITE, async () => {
      await env.DB.prepare(
        "UPDATE articles SET stage = 'analyzed', stage_updated_at = ?2 WHERE id = ?1",
      )
        .bind(id, NOW - 5)
        .run();
    });
    expect(await run(id, t)).toMatchObject({
      status: "ok",
      advanced: false,
      approved: false,
    });
    expect(await reviewRows(id)).toEqual([]);
  });

  it("the body changed during the call: the approval does not name the new body", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config), GOOD_WRITE, async () => {
      await env.DB.prepare("UPDATE articles SET body_sha = ?2 WHERE id = ?1")
        .bind(id, "b".repeat(64))
        .run();
    });
    await run(id, t);
    expect(await reviewRows(id)).toEqual([]);
  });

  it("over budget: no request; stage_updated_at and requeue_count reset", async () => {
    await resetLedger(0);
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config));
    expect(await run(id, t)).toEqual({
      status: "deferred",
      reason: "over_budget",
    });
    expect(t.calls).toHaveLength(0);
    expect(await articleRow(id)).toMatchObject({
      stage: "body_ready",
      stage_updated_at: NOW,
      requeue_count: 0,
    });
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
  });

  it("no analysis config: no request; stage_updated_at and requeue_count reset", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto", null));
    const t = models(fakeAnswers(config));
    expect(await run(id, t)).toEqual({
      status: "deferred",
      reason: "no_config",
    });
    expect(t.calls).toHaveLength(0);
    expect(await articleRow(id)).toMatchObject({
      stage: "body_ready",
      stage_updated_at: NOW,
      requeue_count: 0,
    });
  });

  it("input too large for Jev: logged, no DB write, the requeue count runs out", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The title is never cut.
    const id = await seedReady(await seedIndustryRow("alpha", "auto"), {
      title: "t".repeat(100_000),
    });
    const t = models(fakeAnswers(config));
    expect(await run(id, t)).toEqual({
      status: "failed",
      reason: "JevInputTooLargeError",
    });
    expect(t.calls).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ analyze: id, error: "JevInputTooLargeError" }),
    );
    expect(await articleRow(id)).toMatchObject({
      stage: "body_ready",
      stage_updated_at: NOW - 31 * MIN,
      requeue_count: 2,
    });
  });
});

describe("Jev input", () => {
  const validator = new Validator(JSON.parse(schemaInput), "2020-12", false);

  it("what is sent passes the official schema-input.json; every question is UNTRUSTED-prefixed", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config));
    await run(id, t);
    const sent = t.calls.find((c) => c.model === "typesafe/jev")!.input as {
      state: Record<string, unknown>;
      questions: Record<string, JevQuestion>;
    };
    const result = validator.validate(JSON.parse(JSON.stringify(sent)));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(sent.state).toMatchObject({ body: BODY, section: "alpha" });
    const questions = Object.values(sent.questions);
    // prefilter, category, content_type, noise, 5 dims, 2 labels.
    expect(questions).toHaveLength(11);
    for (const q of questions) {
      expect(q.instructions.startsWith(UNTRUSTED)).toBe(true);
    }
  });

  it("an article without summary or date still passes the schema", () => {
    const { state, questions } = buildAnalysisRequest(
      { title: "t", summary: null, publishedAt: null },
      { name: "" },
      { name: "alpha", analysis: config },
      "",
    );
    const input = buildJevInput(state, questions);
    expect(validator.validate(input).valid).toBe(true);
  });

  it("the validator rejects a score question with one criterion", () => {
    const input = {
      state: { title: "t" },
      questions: { q: { type: "score", instructions: "x", criteria: ["a"] } },
    };
    expect(validator.validate(input).valid).toBe(false);
  });
});

describe("promptVersion", () => {
  it("is 16 hex characters and ignores key order", async () => {
    const v = await promptVersion(config);
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    const reordered = Object.fromEntries(
      Object.entries(config).reverse(),
    ) as AnalysisConfig;
    expect(await promptVersion(reordered)).toBe(v);
  });

  it("changes with the config", async () => {
    const other = fakeAnalysisConfig({
      thresholds: { prefilterMinRelevant: 0.3, select: 61 },
    });
    expect(await promptVersion(other)).not.toBe(await promptVersion(config));
  });
});
