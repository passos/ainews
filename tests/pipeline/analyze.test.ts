// `analyze` messages (#7). Jev and the `write` model are a fake transport
// behind the real model client and ledger; R2 and D1 are the test bindings.
import { Validator } from "@cfworker/json-schema";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analysisVersion,
  analyzeArticle,
  effectivePublishMode,
} from "../../src/pipeline/analyze/analyze";
import type { AnalysisConfig } from "../../src/pipeline/analyze/config";
import { LABELS } from "../../src/pipeline/analyze/labels";
import {
  UNTRUSTED,
  WRITE_MAX_OUTPUT_TOKENS,
  WRITE_THINKING,
  buildWriteRequest,
} from "../../src/pipeline/analyze/prompts";
import {
  buildAnalysisRequest,
  promptVersion,
} from "../../src/pipeline/analyze/questions";
import type { AnalysisAnswers } from "../../src/pipeline/analyze/score";
import type { IngestMessage, PipelineEnv } from "../../src/pipeline/messages";
import { runQueue } from "../../src/pipeline/queue";
import { buildJevInput } from "../../src/providers/jev";
import type { JevQuestion } from "../../src/providers/jev";
import { acquire } from "../../src/providers/ledger";
import { reanalyzeArticle } from "../../src/server/admin/ops";
import {
  choice,
  fakeAnalysisConfig,
  fakeAnswers,
  jevResponse,
} from "../fixtures/analysis/config";
import schemaInput from "../fixtures/jev/schema-input.json?raw";
import {
  budgetRow,
  fakeTransport,
  ledgerRow,
  resetLedger,
  TODAY,
} from "../providers/fakes";
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

function googleText(text: string, finishReason?: string) {
  return {
    candidates: [
      { content: { role: "model", parts: [{ text }] }, finishReason },
    ],
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

/**
 * Ledger key of one model call for the article's body version `sha` and
 * reanalysis generation `generation` (#81).
 */
async function keyOf(
  slot: "analyze" | "write",
  id: number,
  sha = SHA,
  generation = 0,
) {
  return `${slot}:${id}:${sha.slice(0, 16)}:${analysisVersion(await promptVersion(config), generation)}`;
}

/** A write ledger row in a state `acquire` does not hand out again. */
async function seedWriteRow(
  id: number,
  status: "failed" | "unknown",
  opts: { failures: number },
) {
  await env.DB.prepare(
    `INSERT INTO llm_calls (logical_key, slot, model, channel, status, attempt,
       failures, sent_at, error, created_at, updated_at)
     VALUES (?1, 'write', 'google/gemini-3.8-flash', 'gateway', ?2, ?3, ?3,
       ?4, ?5, ?6, ?6)`,
  )
    .bind(
      await keyOf("write", id),
      status,
      opts.failures,
      status === "unknown" ? NOW - 1 : null,
      status === "failed" ? "boom" : null,
      NOW - 1,
    )
    .run();
}

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

  it.each(["finance", "Finance", " finance "])(
    "finance (slug %j) with publish_mode 'auto' is never approved automatically",
    async (slug) => {
      const id = await seedReady(await seedIndustryRow(slug, "auto"));
      const result = await run(id, models(fakeAnswers(config)));
      expect(result).toMatchObject({
        stage: "analyzed",
        selected: true,
        written: true,
        approved: false,
      });
      expect(await reviewRows(id)).toEqual([]);
      expect(effectivePublishMode({ slug, publish_mode: "auto" })).toBe(
        "review",
      );
    },
  );

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
    const bad = JSON.stringify({ title: "x", summary: "y".repeat(801) });
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

  it("write fails at the transport: the error reaches runQueue, the article stays body_ready", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    await expect(
      run(id, models(fakeAnswers(config), new Error("connection lost"))),
    ).rejects.toThrow("connection lost");
    expect(await articleRow(id)).toMatchObject({
      stage: "body_ready",
      stage_updated_at: NOW - 31 * MIN,
      requeue_count: 2,
    });
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
    expect(await reviewRows(id)).toEqual([]);
  });

  // The write call failed for good (#55): the article must not move on
  // without a summary; the sweep sends it again and the judge answer is
  // already in the ledger.
  describe.each([
    [
      "CallFailedError",
      async (id: number) => seedWriteRow(id, "failed", { failures: 3 }),
      () => googleText(GOOD_WRITE),
    ],
    [
      "CallUnknownError",
      async (id: number) => seedWriteRow(id, "unknown", { failures: 0 }),
      () => googleText(GOOD_WRITE),
    ],
    ["ResponseParseError", async () => {}, () => ({ candidates: [] })],
  ] as const)("write ends with %s", (name, setup, reply) => {
    it("failed, stays body_ready, no analyses row, no approval", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const id = await seedReady(await seedIndustryRow("alpha", "auto"));
      await setup(id);
      const t = fakeTransport(async (model) =>
        model === "typesafe/jev" ? jevResponse(fakeAnswers(config)) : reply(),
      );
      expect(await run(id, t)).toEqual({ status: "failed", reason: name });
      expect(jevCalls(t)).toBe(1);
      expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
      expect(await reviewRows(id)).toEqual([]);
      expect(await articleRow(id)).toMatchObject({
        stage: "body_ready",
        stage_updated_at: NOW - 31 * MIN,
        requeue_count: 2,
      });
    });
  });
});

describe("write output cap", () => {
  it("the write request has the 4000-token cap and the thinking config", () => {
    const request = buildWriteRequest(config, {
      title: "t",
      summary: "s",
      body: "b",
      source: "src",
    });
    expect(WRITE_MAX_OUTPUT_TOKENS).toBe(4000);
    expect(request.maxOutputTokens).toBe(4000);
    // "low" is the value the real probe accepted (prompts.ts); "minimal" is not.
    expect(WRITE_THINKING).toStrictEqual({ thinkingLevel: "low" });
    expect(request.thinkingConfig).toBe(WRITE_THINKING);
  });

  it("finishReason MAX_TOKENS: a warning names the write ledger key; the ledger row stays completed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = fakeTransport(async (model) =>
      model === "typesafe/jev"
        ? jevResponse(fakeAnswers(config))
        : googleText('{"title": "cut', "MAX_TOKENS"),
    );
    const result = await run(id, t);
    expect(result).toMatchObject({ stage: "analyzed", written: false });
    const key = await keyOf("write", id);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain(key);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("MAX_TOKENS");
    expect(await ledgerRow(key)).toMatchObject({ status: "completed" });
    // The body sent: the new cap and the thinking level.
    const sent = t.calls.find((c) => c.model.startsWith("google/"));
    expect(
      (sent?.input as { generationConfig: unknown }).generationConfig,
    ).toStrictEqual({
      maxOutputTokens: 4000,
      thinkingConfig: { thinkingLevel: "low" },
    });
  });

  it("finishReason STOP: no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = fakeTransport(async (model) =>
      model === "typesafe/jev"
        ? jevResponse(fakeAnswers(config))
        : googleText(GOOD_WRITE, "STOP"),
    );
    expect(await run(id, t)).toMatchObject({ written: true });
    expect(warn).not.toHaveBeenCalled();
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
    // The analyses insert is gated on the stage write.
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
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

  it("the body changed during the call: nothing is committed, the article stays body_ready", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config), GOOD_WRITE, async () => {
      await env.DB.prepare("UPDATE articles SET body_sha = ?2 WHERE id = ?1")
        .bind(id, "b".repeat(64))
        .run();
    });
    expect(await run(id, t)).toMatchObject({
      status: "ok",
      advanced: false,
      approved: false,
    });
    expect(await articleRow(id)).toMatchObject({
      stage: "body_ready",
      stage_updated_at: NOW - 31 * MIN,
      body_sha: "b".repeat(64),
    });
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
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

describe("races, body versions and retries", () => {
  it("two deliveries with the same now: the loser commits nothing and approves nothing", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config));
    const base = pipelineEnv(fakeQueue(), ENABLED);
    // Delivery B has read body_ready; delivery A runs to its commit before B
    // reads the body. Both use the same `now`; B gets both answers from the
    // ledger.
    const late: PipelineEnv = {
      ...base,
      BODIES: {
        get: async (key: string) => {
          const first = await analyzeArticle(base, id, NOW, { transport: t });
          expect(first).toMatchObject({
            stage: "analyzed",
            written: true,
            approved: true,
            advanced: true,
          });
          return env.BODIES.get(key);
        },
      } as unknown as R2Bucket,
    };
    const second = await analyzeArticle(late, id, NOW, { transport: t });
    expect(second).toMatchObject({
      status: "ok",
      written: true,
      advanced: false,
      approved: false,
    });
    expect(jevCalls(t)).toBe(1);
    expect(writeCalls(t)).toBe(1);
    expect(await reviewRows(id)).toEqual([
      { body_sha: SHA, decision: "approved", reviewer: "auto" },
    ]);
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(1);
  });

  it("a new body version is judged again: the ledger keys name the body", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "review"));
    const t = models(fakeAnswers(config));
    await run(id, t);
    const sha2 = "c".repeat(64);
    await env.BODIES.put(`bodies/${id}/${sha2}.md`, `${BODY} More.`);
    await env.DB.prepare(
      "UPDATE articles SET body_sha = ?2, stage = 'body_ready' WHERE id = ?1",
    )
      .bind(id, sha2)
      .run();
    await run(id, t);
    expect(jevCalls(t)).toBe(2);
    expect(writeCalls(t)).toBe(2);
    expect((await ledgerRow(await keyOf("analyze", id, sha2)))?.status).toBe(
      "completed",
    );
  });

  it("Jev fits the budget, write does not: deferred with the clock reset; the retry only writes", async () => {
    // Jev reserves ~60 micro-USD and spends 42 (1,000 input tokens); write
    // reserves at least 400 x $3.75/1M = 1,500.
    await resetLedger(1_000);
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config));
    expect(await run(id, t)).toEqual({
      status: "deferred",
      reason: "over_budget",
    });
    expect(jevCalls(t)).toBe(1);
    expect(writeCalls(t)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
    expect(await articleRow(id)).toMatchObject({
      stage: "body_ready",
      stage_updated_at: NOW,
      requeue_count: 0,
    });
    // Raise the cap in place: resetLedger would also clear the Jev result.
    await env.DB.prepare(
      "UPDATE budgets SET cap_micros = 1000000 WHERE day = ?1 AND channel = 'gateway'",
    )
      .bind(TODAY)
      .run();
    expect(await run(id, t)).toMatchObject({
      stage: "analyzed",
      written: true,
    });
    expect(jevCalls(t)).toBe(1);
    expect(writeCalls(t)).toBe(1);
    expect((await analysisRow(id))?.summary_en).toBe(
      JSON.parse(GOOD_WRITE).summary,
    );
  });

  it.each(["write", "analyze"] as const)(
    "%s call in progress elsewhere: deferred, no DB write",
    async (slot) => {
      const id = await seedReady(await seedIndustryRow("alpha", "auto"));
      // A live lease held by another delivery.
      await acquire(env.DB, {
        logicalKey: await keyOf(slot, id),
        slot: slot === "write" ? "write" : "judge",
        model: slot === "write" ? "google/gemini-3.8-flash" : "typesafe/jev",
        channel: "gateway",
        now: NOW,
      });
      const t = models(fakeAnswers(config));
      expect(await run(id, t)).toEqual({
        status: "deferred",
        reason: "in_progress",
      });
      expect(writeCalls(t)).toBe(0);
      expect(jevCalls(t)).toBe(slot === "write" ? 1 : 0);
      expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
      expect(await articleRow(id)).toMatchObject({
        stage: "body_ready",
        stage_updated_at: NOW - 31 * MIN,
        requeue_count: 2,
      });
    },
  );

  it.each([
    ["noise", { noise: "made_up" }],
    ["content_type", { contentType: "made_up" }],
  ] as const)(
    "Jev returns a %s choice that is not a criterion: failed, billed once, no DB write",
    async (_name, patch) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const id = await seedReady(await seedIndustryRow("alpha", "auto"));
      const t = models(fakeAnswers(config, patch));
      expect(await run(id, t)).toEqual({
        status: "failed",
        reason: "ResponseParseError",
      });
      expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
      expect(await articleRow(id)).toMatchObject({
        stage: "body_ready",
        stage_updated_at: NOW - 31 * MIN,
        requeue_count: 2,
      });
      const ledger = await ledgerRow(await keyOf("analyze", id));
      expect(ledger).toMatchObject({ status: "failed", failures: 1 });
      expect(ledger?.error).toMatch(/^parse: .*choice/);
      expect((await budgetRow("gateway"))?.spent_micros).toBe(
        ledger?.cost_micros,
      );
      expect((await budgetRow("gateway"))?.reserved_micros).toBe(0);
    },
  );
});

describe("reanalysis generation (#81)", () => {
  it("analysisVersion: generation 0 is the version itself, later generations append :r{n}", () => {
    expect(analysisVersion("abc", 0)).toBe("abc");
    expect(analysisVersion("abc", 2)).toBe("abc:r2");
  });

  it("after reanalysis the next run uses new ledger keys; the old rows stay completed; a second analyses row", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "review"));
    const t = models(fakeAnswers(config));
    await run(id, t);
    await reanalyzeArticle(
      env.DB,
      { send: async () => {} },
      { articleId: id, expectedStage: "analyzed" },
    );
    await run(id, t);

    expect(jevCalls(t)).toBe(2);
    expect(writeCalls(t)).toBe(2);
    expect((await ledgerRow(await keyOf("analyze", id)))?.status).toBe(
      "completed",
    );
    expect((await ledgerRow(await keyOf("write", id)))?.status).toBe(
      "completed",
    );
    expect((await ledgerRow(await keyOf("analyze", id, SHA, 1)))?.status).toBe(
      "completed",
    );
    expect((await ledgerRow(await keyOf("write", id, SHA, 1)))?.status).toBe(
      "completed",
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM analyses WHERE article_id = ?1",
        id,
      ),
    ).toBe(2);
    const latest = await env.DB.prepare(
      `SELECT prompt_version FROM analyses WHERE article_id = ?1
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(id)
      .first<{ prompt_version: string }>();
    expect(latest?.prompt_version).toBe(`${await promptVersion(config)}:r1`);
    expect((await articleRow(id))?.stage).toBe("analyzed");
  });

  it("the generation changed during the call: nothing is committed; the old call still settles", async () => {
    const id = await seedReady(await seedIndustryRow("alpha", "auto"));
    const t = models(fakeAnswers(config), GOOD_WRITE, async () => {
      await env.DB.prepare(
        "UPDATE articles SET analysis_generation = 1 WHERE id = ?1",
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
      stage: "body_ready",
      stage_updated_at: NOW - 31 * MIN,
    });
    expect(await count("SELECT count(*) AS n FROM analyses")).toBe(0);
    expect(await reviewRows(id)).toEqual([]);
    expect((await ledgerRow(await keyOf("analyze", id)))?.status).toBe(
      "completed",
    );
    expect(
      await count("SELECT coalesce(sum(reserved_micros), 0) AS n FROM budgets"),
    ).toBe(0);
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

  it("follows the question texts in labels.ts without a manual bump", async () => {
    const before = await promptVersion(config);
    const options = LABELS.claim_mode.options as Record<string, string>;
    const old = options.fact;
    options.fact = `${old} Changed.`;
    try {
      expect(await promptVersion(config)).not.toBe(before);
    } finally {
      options.fact = old;
    }
    expect(await promptVersion(config)).toBe(before);
  });
});
