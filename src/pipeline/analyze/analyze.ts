// Handler for `analyze` messages: one Jev call, deterministic scoring, an
// English title and summary for selected articles, then one commit.
//
//   MODEL_CALLS_ENABLED -> stage = body_ready -> industry analysis config
//     -> R2 bodies/{id}/{body_sha}.md -> judge (ledger key
//        analyze:{id}:{sha16}:{v}) -> scoreAnalysis
//     -> selected: write (ledger key write:{id}:{sha16}:{v})
//     -> one batch(), each statement gated on the one before (changes()):
//        articles stage (stage and body_sha conditions) -> analyses
//        -> auto-approved reviews row (auto industries, valid write only)
//
// A repeated delivery stops at the stage check, or gets both model results
// from the ledger (no second request). Selected articles go on to Q_GROUP
// in #11.
import { isEnabled } from "../../lib/flags";
import { ResponseParseError } from "../../providers/adapters";
import { JevInputTooLargeError } from "../../providers/jev";
import {
  BudgetExceededError,
  CallFailedError,
  CallInProgressError,
  CallUnknownError,
  createModelClient,
} from "../../providers/models";
import type { ModelClient } from "../../providers/models";
import type { ModelTransport } from "../../providers/transport";
import { sendGroup, type PipelineEnv } from "../messages";
import { parseAnalysisConfig } from "./config";
import type { AnalysisConfig } from "./config";
import { labelValue } from "./labels";
import { buildWriteRequest, parseWriteOutput } from "./prompts";
import type { WriteOutput } from "./prompts";
import { buildAnalysisRequest, promptVersion } from "./questions";
import { scoreAnalysis } from "./score";
import type { AnalysisAnswers } from "./score";

/** Injected like BodyDeps: production sends through env.AI (queue.ts). */
export interface AnalyzeDeps {
  transport: ModelTransport;
}

export type AnalyzeResult =
  | { status: "disabled" | "skipped" }
  /** No DB write except, for budget/config, stage_updated_at (sweep). */
  | { status: "deferred" | "failed"; reason: string }
  | {
      status: "ok";
      stage: "analyzed" | "dropped";
      selected: boolean;
      total: number;
      written: boolean;
      approved: boolean;
      /** False if another delivery moved the stage or the body changed. */
      advanced: boolean;
    };

interface Row {
  id: number;
  title: string;
  summary: string | null;
  published_at: number | null;
  stage: string;
  body_sha: string | null;
  source_name: string;
  slug: string;
  industry_name: string;
  publish_mode: "auto" | "review";
  config: string;
}

/** Slug of the Finance industry. #8's seed must import it, not repeat it. */
export const FINANCE_SLUG = "finance";

/**
 * Finance is never approved automatically (architecture §7, N§4), whatever
 * publish_mode the admin sets. The slug compare ignores case and spaces.
 */
export function effectivePublishMode(industry: {
  slug: string;
  publish_mode: "auto" | "review";
}): "auto" | "review" {
  return industry.slug.trim().toLowerCase() === FINANCE_SLUG
    ? "review"
    : industry.publish_mode;
}

export async function analyzeArticle(
  env: PipelineEnv,
  articleId: number,
  now: number,
  deps: AnalyzeDeps,
): Promise<AnalyzeResult> {
  // First: with the flag off nothing is read or written.
  if (!isEnabled(env, "MODEL_CALLS_ENABLED")) return { status: "disabled" };
  const row = await env.DB.prepare(
    `SELECT a.id, a.title, a.summary, a.published_at, a.stage, a.body_sha,
       COALESCE(NULLIF(s.name, ''), s.site_domain, '') AS source_name,
       i.slug, i.name AS industry_name, i.publish_mode, i.config
     FROM articles AS a
       JOIN sources AS s ON s.id = a.source_id
       JOIN industries AS i ON i.id = a.industry_id
     WHERE a.id = ?1`,
  )
    .bind(articleId)
    .first<Row>();
  // Duplicate delivery: the stage is done. body.ts always sets body_sha.
  if (!row || row.stage !== "body_ready" || !row.body_sha) {
    return { status: "skipped" };
  }
  const sha = row.body_sha;

  const config = parseAnalysisConfig(row.config);
  // The normal state before #8 fills the configs: wait for the sweep.
  if (!config) return touch(env, articleId, now, "no_config");

  const object = await env.BODIES.get(`bodies/${articleId}/${sha}.md`);
  if (!object) return failed(articleId, "body_missing");
  const bodyMd = await object.text();

  const version = await promptVersion(config);
  // The body version is part of the keys: a new body is judged again.
  const keyPart = `${articleId}:${sha.slice(0, 16)}:${version}`;
  const models = createModelClient({
    db: env.DB,
    transport: deps.transport,
    env,
    now: () => now,
  });
  const { state, questions } = buildAnalysisRequest(
    { title: row.title, summary: row.summary, publishedAt: row.published_at },
    { name: row.source_name },
    { name: row.industry_name, analysis: config },
    bodyMd,
  );

  let answers: AnalysisAnswers;
  try {
    // The questions above have exactly these names and types.
    answers = (await models.judge(
      `analyze:${keyPart}`,
      state,
      questions,
    )) as unknown as AnalysisAnswers;
  } catch (error) {
    return modelError(env, articleId, now, error);
  }

  const scored = scoreAnalysis(answers, config);
  const labels: Record<string, string> = {};
  for (const key of config.labels) {
    const answer = answers[key];
    if (answer) labels[key] = labelValue(key, answer);
  }

  let written: WriteOutput | null = null;
  if (scored.selected) {
    try {
      written = await write(models, config, row, bodyMd, `write:${keyPart}`);
    } catch (error) {
      // The article stays body_ready and the sweep sends it again: the judge
      // answer is in the ledger, so only the write is asked for again, up to
      // MAX_ATTEMPTS. Over budget and in-progress are retried the same way;
      // an error modelError does not resolve reaches runQueue's catch.
      // (A write that succeeded but is not the expected JSON is not an
      // error: below, the article goes on without a summary.)
      return modelError(env, articleId, now, error);
    }
  }

  const stage = scored.selected ? "analyzed" : "dropped";
  const approve =
    scored.selected && written !== null && effectivePublishMode(row) === "auto";
  // Each statement runs only if the one before changed a row: changes() is
  // the count of the last completed statement in this batch's transaction.
  // A delivery that lost the stage (or whose body changed) writes nothing,
  // even with the same `now`.
  const statements = [
    // Architecture §5: writing stage also writes stage_updated_at and
    // requeue_count.
    env.DB.prepare(
      `UPDATE articles SET stage = ?2, stage_updated_at = ?3, requeue_count = 0
       WHERE id = ?1 AND stage = 'body_ready' AND body_sha = ?4`,
    ).bind(articleId, stage, now, sha),
    env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type,
         evidence_tags, total_score, created_at, prefilter_relevant,
         prefilter_pass, category, noise_kind, selected, title_en, summary_en,
         jev_raw)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
       WHERE changes() = 1
       ON CONFLICT (article_id, prompt_version) DO NOTHING`,
    ).bind(
      articleId,
      version,
      JSON.stringify(scored.dims),
      scored.contentType,
      JSON.stringify(labels),
      scored.total,
      now,
      scored.prefilterRelevant,
      scored.prefilterPass ? 1 : 0,
      scored.category,
      scored.noiseKind,
      scored.selected ? 1 : 0,
      written?.title ?? null,
      written?.summary ?? null,
      JSON.stringify(answers),
    ),
  ];
  if (approve) {
    // Only if this batch wrote the analyses row, for the body version that
    // was analysed.
    statements.push(
      env.DB.prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
         SELECT id, body_sha, 'approved', 'auto', ?3 FROM articles
         WHERE id = ?1 AND body_sha = ?2 AND stage = 'analyzed'
           AND changes() = 1
         ON CONFLICT (article_id, body_sha) DO NOTHING`,
      ).bind(articleId, sha, now),
    );
  }
  const results = await env.DB.batch(statements);
  const advanced = results[0].meta.changes === 1;
  const approved = approve && results[2]?.meta.changes === 1;

  if (advanced && scored.selected && env.Q_GROUP) {
    await sendGroup(env, [{ kind: "group", articleId }]);
  }

  console.log({
    analyze: articleId,
    stage,
    total: scored.total,
    selected: scored.selected,
    written: written !== null,
    approved,
    advanced,
  });
  return {
    status: "ok",
    stage,
    selected: scored.selected,
    total: scored.total,
    written: written !== null,
    approved,
    advanced,
  };
}

/** Throws model errors; null if the output is not the expected JSON. */
async function write(
  models: ModelClient,
  config: AnalysisConfig,
  row: Row,
  bodyMd: string,
  key: string,
): Promise<WriteOutput | null> {
  const { text, finishReason } = await models.generateText(
    "write",
    key,
    buildWriteRequest(config, {
      title: row.title,
      summary: row.summary ?? "",
      body: bodyMd,
      source: row.source_name,
    }),
  );
  // The ledger row stays completed; the warning makes the cut-off findable
  // in the logs.
  if (finishReason === "MAX_TOKENS") {
    console.warn({ analyze: row.id, write: key, finishReason });
  }
  return parseWriteOutput(text);
}

/** Judge and write errors that this handler resolves; others reach runQueue's catch. */
async function modelError(
  env: PipelineEnv,
  articleId: number,
  now: number,
  error: unknown,
): Promise<AnalyzeResult> {
  if (error instanceof BudgetExceededError) {
    return touch(env, articleId, now, "over_budget");
  }
  if (error instanceof CallInProgressError) {
    return { status: "deferred", reason: "in_progress" };
  }
  if (
    error instanceof CallUnknownError ||
    error instanceof CallFailedError ||
    error instanceof JevInputTooLargeError ||
    // The ledger recorded the failure (billed once); the next delivery
    // asks again, at most MAX_ATTEMPTS times.
    error instanceof ResponseParseError
  ) {
    // Stays body_ready; after MAX_REQUEUES the admin sees it (#9).
    return failed(articleId, error.name, error);
  }
  throw error;
}

/**
 * Resets the backfill clock and count without moving the stage, so the
 * sweep sends the article again every 30 minutes until the budget or the
 * config is there. Without it the article would stop after 3 requeues.
 */
async function touch(
  env: PipelineEnv,
  articleId: number,
  now: number,
  reason: string,
): Promise<AnalyzeResult> {
  await env.DB.prepare(
    `UPDATE articles SET stage_updated_at = ?2, requeue_count = 0
     WHERE id = ?1 AND stage = 'body_ready'`,
  )
    .bind(articleId, now)
    .run();
  console.log({ analyze: articleId, deferred: reason });
  return { status: "deferred", reason };
}

function failed(
  articleId: number,
  reason: string,
  error?: unknown,
): AnalyzeResult {
  console.error({
    analyze: articleId,
    error: reason,
    message: error === undefined ? null : describe(error),
  });
  return { status: "failed", reason };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
