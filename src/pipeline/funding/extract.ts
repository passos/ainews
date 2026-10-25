import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { approvedArticleWhere } from "../../server/publication/articles";
import { isEnabled } from "../../lib/flags";
import {
  convertToMicroUsd,
  convertToMicroUsdExact,
  mergeNames,
  normalizeCompanyKey,
  normalizeRoundKey,
  normalizeSector,
  stageForRoundKey,
} from "../../lib/funding/normalize";
import type {
  ExtractedRound,
  FundingSourceArticle,
  FundingStatus,
} from "../../lib/funding/types";
import { createModelClient, type ModelClient } from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import { FINANCE_SLUG } from "../analyze/analyze";
import type { PipelineEnv } from "../messages";
import {
  FUNDING_PROMPT_VERSION,
  buildFundingRequest,
  parseFundingOutput,
} from "./prompts";

export interface FundingDeps {
  db: D1Database;
  bodies: R2Bucket;
  models: Pick<ModelClient, "generateText">;
  transport: ModelTransport;
  now: () => number;
}

export type FundingExtractResult =
  | { status: "skipped"; articleId: number; reason: string }
  | {
      status: "done";
      articleId: number;
      inserted: number;
      merged: number;
      superseded: number;
      ignored: number;
    };

export interface FundingRow {
  id: number;
  company_name: string;
  company_key: string;
  round_name: string;
  round_key: string;
  amount: number | null;
  currency: string;
  amount_micros: number | null;
  valuation: number | null;
  valuation_micros: number | null;
  sector: string;
  stage: string;
  investors: string;
  lead_investors: string;
  announced_date: string | null;
  article_id: number | null;
  source_url: string;
  source_articles: string;
  status: FundingStatus;
  superseded_by: number | null;
  updated_at: number;
}

/** The model ledger key. Business completion is recorded separately. */
export function fundingLogicalKey(articleId: number, bodySha: string): string {
  return `funding:${articleId}:${FUNDING_PROMPT_VERSION}:${bodySha.slice(0, 16)}`;
}

function defaultDeps(
  env: PipelineEnv,
  overrides: Partial<FundingDeps>,
  nowTime: number,
): FundingDeps {
  const db = overrides.db ?? env.DB;
  const transport =
    overrides.transport ??
    (env.AI
      ? bindingTransport(env.AI, env.AI_GATEWAY_ID ?? "")
      : { run: () => Promise.reject(new Error("no AI binding")) });
  const now = overrides.now ?? (() => nowTime);
  return {
    db,
    bodies: overrides.bodies ?? env.BODIES,
    transport,
    now,
    models: overrides.models ?? createModelClient({ db, transport, env, now }),
  };
}

function parseStrings(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseSources(json: string): FundingSourceArticle[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Same amount, or one side unknown. Different currencies: within 10%. */
function sameAmount(
  existing: Pick<FundingRow, "amount" | "currency" | "amount_micros">,
  next: { amount: number | null; currency: string; micros: number | null },
): boolean {
  if (existing.amount === null || next.amount === null) return true;
  if (existing.currency === next.currency)
    return existing.amount === next.amount;
  const before = convertToMicroUsdExact(existing.amount, existing.currency);
  const after = convertToMicroUsdExact(next.amount, next.currency);
  if (before === null || after === null) return false;
  const difference = before > after ? before - after : after - before;
  return difference * 10n <= (before > after ? before : after);
}

const COLUMNS = `company_name, company_key, round_name, round_key, amount, currency,
  amount_micros, valuation, valuation_micros, sector, stage, investors,
  lead_investors, announced_date, article_id, source_url, source_articles,
  status, superseded_by, correction_reason, created_at, updated_at`;

export interface NewRow {
  companyName: string;
  companyKey: string;
  roundName: string;
  roundKey: string;
  amount: number | null;
  currency: string;
  amountMicros: number | null;
  valuation: number | null;
  valuationMicros: number | null;
  sector: string;
  stage: string;
  investors: string[];
  leadInvestors: string[];
  announcedDate: string | null;
  articleId: number | null;
  sourceUrl: string;
  sources: FundingSourceArticle[];
  correctionReason: string | null;
}

function statement(db: D1Database, query: SQL): D1PreparedStatement {
  const compiled = new SQLiteSyncDialect().sqlToQuery(query);
  return db.prepare(compiled.sql).bind(...compiled.params);
}

interface CurrentArticle {
  id: number;
  bodySha: string;
}
function approvalGuard(article?: CurrentArticle): SQL {
  return article
    ? sql`EXISTS (SELECT 1 FROM articles a
    WHERE a.id = ${article.id} AND a.body_sha = ${article.bodySha}
      AND ${approvedArticleWhere})`
    : sql`1`;
}

/** The receipt check must share the mutation's snapshot; the earlier read is only a fast path. */
function unappliedGuard(
  companyKey: string,
  roundKey: string,
  article?: CurrentArticle,
): SQL {
  return article
    ? sql`NOT EXISTS (
    SELECT 1 FROM funding_rounds f, json_each(f.source_articles) s
    WHERE f.company_key = ${companyKey} AND f.round_key = ${roundKey}
      AND json_extract(s.value, '$.articleId') = ${article.id}
      AND json_extract(s.value, '$.bodySha') = ${article.bodySha}
  )`
    : sql`1`;
}

function expectedRow(row: FundingRow): SQL {
  return sql`id = ${row.id} AND superseded_by IS NULL
    AND status = ${row.status} AND updated_at = ${row.updated_at}
    AND source_articles = ${row.source_articles} AND investors = ${row.investors}
    AND lead_investors = ${row.lead_investors} AND amount IS ${row.amount}
    AND currency = ${row.currency} AND valuation IS ${row.valuation}
    AND announced_date IS ${row.announced_date}`;
}

export function fundingCompletionKey(
  articleId: number,
  bodySha: string,
): string {
  return `funding:done:${articleId}:${FUNDING_PROMPT_VERSION}:${bodySha}`;
}

function insertStatement(
  db: D1Database,
  r: NewRow,
  now: number,
  article?: CurrentArticle,
  gated = false,
) {
  return statement(
    db,
    sql`INSERT INTO funding_rounds (${sql.raw(COLUMNS)})
    SELECT ${r.companyName}, ${r.companyKey}, ${r.roundName}, ${r.roundKey},
      ${r.amount}, ${r.currency}, ${r.amountMicros}, ${r.valuation}, ${r.valuationMicros},
      ${r.sector}, ${r.stage}, ${JSON.stringify(r.investors)}, ${JSON.stringify(r.leadInvestors)},
      ${r.announcedDate}, ${r.articleId}, ${r.sourceUrl}, ${JSON.stringify(r.sources)},
      'pending_review', NULL, ${r.correctionReason}, ${now}, ${now}
    WHERE ${gated ? sql`changes() = 1` : sql`1`} AND ${approvalGuard(article)}
    ${gated ? sql`` : sql`ON CONFLICT DO NOTHING`}`,
  );
}

function fmtAmount(amount: number | null, currency: string): string {
  return amount === null ? "undisclosed" : `${amount} ${currency}`;
}

export async function extractFundingRounds(
  env: PipelineEnv,
  articleId: number,
  commitNow: number,
  overrides: Partial<FundingDeps> = {},
): Promise<FundingExtractResult> {
  if (!isEnabled(env, "MODEL_CALLS_ENABLED")) {
    return { status: "skipped", articleId, reason: "model_calls_disabled" };
  }
  const deps = defaultDeps(env, overrides, commitNow);

  // Only a Finance article whose current body version is approved.
  const article = await statement(
    deps.db,
    sql`
      SELECT a.id, a.title, a.canonical_url, a.published_at, a.body_sha
      FROM articles a JOIN industries i ON i.id = a.industry_id
      WHERE a.id = ${articleId} AND i.slug = ${FINANCE_SLUG}
        AND a.body_sha IS NOT NULL AND ${approvedArticleWhere}`,
  ).first<{
    id: number;
    title: string;
    canonical_url: string;
    published_at: number | null;
    body_sha: string;
  }>();
  if (!article) {
    return { status: "skipped", articleId, reason: "not_approved_finance" };
  }

  const completionKey = fundingCompletionKey(article.id, article.body_sha);
  if (
    await deps.db
      .prepare("SELECT key FROM settings WHERE key = ?1")
      .bind(completionKey)
      .first()
  ) {
    return { status: "skipped", articleId, reason: "already_completed" };
  }
  const current = { id: article.id, bodySha: article.body_sha };

  const obj = await deps.bodies.get(
    `bodies/${article.id}/${article.body_sha}.md`,
  );
  if (!obj) {
    return { status: "skipped", articleId, reason: "body_missing" };
  }
  const body = await obj.text();

  const publishedDate =
    article.published_at !== null
      ? new Date(article.published_at).toISOString().slice(0, 10)
      : null;

  const res = await deps.models.generateText(
    "reason",
    fundingLogicalKey(article.id, article.body_sha),
    buildFundingRequest({
      id: article.id,
      title: article.title,
      url: article.canonical_url,
      publishedAt: publishedDate,
      body,
    }),
  );
  if (res.finishReason !== "STOP")
    throw new Error("Funding extraction requires STOP");
  const parsed = parseFundingOutput(res.text);
  if (!parsed) throw new Error("Invalid funding output");
  await assertCurrentApproval(deps.db, current);

  const out = { inserted: 0, merged: 0, superseded: 0, ignored: 0 };
  const seenAt = deps.now();
  const source: FundingSourceArticle = {
    articleId: article.id,
    bodySha: article.body_sha,
    url: article.canonical_url,
    title: article.title,
    seenAt,
  };

  // One round at a time: two rounds of the same company must not race.
  for (const round of parsed.rounds) {
    if (!round.isFundingAnnouncement) continue;
    const companyKey = normalizeCompanyKey(round.companyName);
    if (!companyKey) continue;
    const result = await applyRound(
      deps,
      round,
      companyKey,
      article,
      publishedDate,
      source,
      current,
    );
    out[result]++;
  }
  const marker = await statement(
    deps.db,
    sql`INSERT INTO settings (key, value, updated_at)
    SELECT ${completionKey}, 'true', ${deps.now()} WHERE ${approvalGuard(current)}
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run();
  if (marker.meta.changes !== 1)
    throw new Error("Approved article body changed");
  return { status: "done", articleId, ...out };
}

async function assertCurrentApproval(db: D1Database, article: CurrentArticle) {
  if (
    !(await statement(
      db,
      sql`SELECT 1 WHERE ${approvalGuard(article)}`,
    ).first())
  ) {
    throw new Error("Approved article body changed");
  }
}

async function applyRound(
  deps: FundingDeps,
  round: ExtractedRound,
  companyKey: string,
  article: { id: number; canonical_url: string },
  publishedDate: string | null,
  source: FundingSourceArticle,
  current: CurrentArticle,
): Promise<"inserted" | "merged" | "superseded" | "ignored"> {
  const roundKey = normalizeRoundKey(round.roundName);
  const currency = (round.currency ?? "").toUpperCase();
  // An amount without a currency is not guessed at.
  const amount =
    round.amount != null && currency ? Math.round(round.amount) : null;
  const valuation =
    round.valuation != null && currency ? Math.round(round.valuation) : null;
  const next = {
    amount,
    currency: currency || "USD",
    micros: amount !== null ? convertToMicroUsd(amount, currency) : null,
  };
  const valuationMicros =
    valuation !== null ? convertToMicroUsd(valuation, currency) : null;
  const now = deps.now();

  for (let attempt = 0; attempt < 16; attempt++) {
    await assertCurrentApproval(deps.db, current);
    // Provenance on historical and rejected rows is also an applied-result receipt.
    if (
      await statement(
        deps.db,
        sql`SELECT 1 FROM funding_rounds f, json_each(f.source_articles) s
      WHERE f.company_key = ${companyKey} AND f.round_key = ${roundKey}
        AND json_extract(s.value, '$.articleId') = ${source.articleId}
        AND json_extract(s.value, '$.bodySha') = ${source.bodySha} LIMIT 1`,
      ).first()
    )
      return "ignored";
    const existing = await deps.db
      .prepare(
        `SELECT * FROM funding_rounds
       WHERE company_key = ?1 AND round_key = ?2 AND superseded_by IS NULL`,
      )
      .bind(companyKey, roundKey)
      .first<FundingRow>();

    const fresh: NewRow = {
      companyName: round.companyName.trim(),
      companyKey,
      roundName: round.roundName.trim(),
      roundKey,
      amount,
      currency: next.currency,
      amountMicros: next.micros,
      valuation,
      valuationMicros,
      sector: normalizeSector(round.sector),
      stage: stageForRoundKey(roundKey),
      investors: mergeNames([], round.investors),
      leadInvestors: mergeNames([], round.leadInvestors),
      announcedDate: round.announcedDate ?? publishedDate,
      articleId: article.id,
      sourceUrl: article.canonical_url,
      sources: [source],
      correctionReason: null,
    };

    if (!existing) {
      const inserted = await insertStatement(
        deps.db,
        fresh,
        now,
        current,
      ).run();
      if (inserted.meta.changes === 1) return "inserted";
      continue;
    }
    // A rejected record is not amended or revived.
    if (existing.status === "rejected") return "ignored";

    const oldSources = parseSources(existing.source_articles);
    const sources = oldSources.some(
      (s) => s.articleId === source.articleId && s.bodySha === source.bodySha,
    )
      ? oldSources
      : [...oldSources, source];
    const investors = mergeNames(
      parseStrings(existing.investors),
      round.investors,
    );
    const leadInvestors = mergeNames(
      parseStrings(existing.lead_investors),
      round.leadInvestors,
    );
    const amountConflict = !sameAmount(existing, next);
    // An unknown amount is filled from this report; a known one is kept.
    const base =
      existing.amount === null
        ? { amount, currency: next.currency, micros: next.micros }
        : {
            amount: existing.amount,
            currency: existing.currency,
            micros: existing.amount_micros,
          };
    const mergedAmount = base.amount;
    const mergedValuation = existing.valuation ?? valuation;
    const mergedDate = existing.announced_date ?? fresh.announcedDate;

    const sourceChanged = sources !== oldSources;
    const factChanged =
      JSON.stringify(investors) !== existing.investors ||
      JSON.stringify(leadInvestors) !== existing.lead_investors ||
      mergedAmount !== existing.amount ||
      mergedValuation !== existing.valuation ||
      mergedDate !== existing.announced_date;

    const needsNewVersion =
      amountConflict || (existing.status === "published" && factChanged);

    if (!needsNewVersion) {
      if (!factChanged && !sourceChanged) return "ignored";
      const changed = await statement(
        deps.db,
        sql`UPDATE funding_rounds SET source_articles = ${JSON.stringify(sources)}, updated_at = ${now}
      ${
        factChanged
          ? sql`, investors = ${JSON.stringify(investors)}, lead_investors = ${JSON.stringify(leadInvestors)},
        amount = ${base.amount}, currency = ${base.currency}, amount_micros = ${base.micros},
        valuation = ${mergedValuation}, valuation_micros = ${existing.valuation === null ? valuationMicros : existing.valuation_micros},
        announced_date = ${mergedDate}`
          : sql``
      }
      WHERE ${expectedRow(existing)} AND ${approvalGuard(current)}
        AND ${unappliedGuard(companyKey, roundKey, current)}`,
      ).run();
      if (changed.meta.changes !== 1) continue;
      return "merged";
    }

    // A new version. Old row keeps its data and points at the new row; the
    // unique index covers only superseded_by IS NULL, so the old row is
    // pointed at itself first, then at the new row once that exists.
    const useNewAmount = amountConflict;
    const reason = amountConflict
      ? (round.correctionReason ??
        `Amount revised per ${article.canonical_url}`)
      : (round.correctionReason ?? "Added details from an additional report");
    const version: NewRow = {
      ...fresh,
      amount: useNewAmount ? amount : base.amount,
      currency: useNewAmount ? next.currency : base.currency,
      amountMicros: useNewAmount ? next.micros : base.micros,
      valuation: mergedValuation,
      valuationMicros:
        existing.valuation === null
          ? valuationMicros
          : existing.valuation_micros,
      investors,
      leadInvestors,
      announcedDate: mergedDate,
      sector: existing.sector,
      sources,
      articleId: existing.article_id ?? article.id,
      sourceUrl: existing.source_url,
      correctionReason: reason,
    };
    if (
      await supersedeFundingRound(
        deps.db,
        existing.id,
        version,
        now,
        existing,
        current,
      )
    )
      return "superseded";
  }
  throw new Error("Funding round changed during concurrent updates; retry");
}

/** Replace a snapshot atomically under the immediate FK and partial unique index. */
export async function supersedeFundingRound(
  db: D1Database,
  oldId: number,
  row: NewRow,
  now: number,
  expected?: FundingRow,
  article?: CurrentArticle,
): Promise<boolean> {
  const old =
    expected ??
    (await db
      .prepare("SELECT * FROM funding_rounds WHERE id = ?1")
      .bind(oldId)
      .first<FundingRow>());
  if (!old) return false;
  const [update, inserted, linked] = await db.batch([
    statement(
      db,
      sql`UPDATE funding_rounds SET superseded_by = id, updated_at = ${now}
      WHERE ${expectedRow(old)} AND status != 'rejected' AND ${approvalGuard(article)}
        AND ${unappliedGuard(row.companyKey, row.roundKey, article)}`,
    ),
    insertStatement(db, row, now, article, true),
    statement(
      db,
      sql`UPDATE funding_rounds SET superseded_by = (
      SELECT id FROM funding_rounds WHERE company_key = ${row.companyKey}
        AND round_key = ${row.roundKey} AND superseded_by IS NULL)
      WHERE id = ${oldId} AND superseded_by = id AND changes() = 1`,
    ),
    statement(
      db,
      sql`INSERT INTO corrections (target_type, target_id, body, created_at)
      WITH RECURSIVE ancestors(id, depth) AS (
        SELECT ${oldId}, 0 UNION ALL
        SELECT p.id, a.depth + 1 FROM funding_rounds p JOIN ancestors a ON p.superseded_by = a.id
      )
      SELECT 'funding_rounds', (SELECT superseded_by FROM funding_rounds WHERE id = ${oldId}),
        'Funding record updated: ' || COALESCE(CAST(f.amount AS TEXT), 'undisclosed') || ' ' || f.currency ||
        ' to ' || ${fmtAmount(row.amount, row.currency)} || ': ' || ${row.correctionReason ?? "details revised"}, ${now}
      FROM funding_rounds f JOIN ancestors a ON a.id = f.id
      WHERE f.status = 'published' AND changes() = 1 ORDER BY a.depth ASC LIMIT 1`,
    ),
  ]);
  if (
    update.meta.changes === 1 &&
    (inserted.meta.changes !== 1 || linked.meta.changes !== 1)
  ) {
    throw new Error("Funding version batch did not link its replacement");
  }
  return update.meta.changes === 1;
}
