import {
  applyFundingPatch,
  reportedFundingFacts,
  validateFundingEvidence,
} from "../../lib/funding/identity";
import {
  captureFundingObservation,
  fundingDecisionGuard,
  fundingReceiptStatement,
  fundingStatement,
  holdFundingObservation,
  observationPayload,
  readFundingObservation,
  type ObservationApplication,
} from "./observations";
import { sql, type SQL } from "drizzle-orm";

import { approvedArticleWhere } from "../../server/publication/articles";
import { isEnabled } from "../../lib/flags";
import { convertToMicroUsd, mergeNames } from "../../lib/funding/normalize";
import type {
  ConfirmedFundingIdentity,
  FundingFacts,
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
  stage: FundingFacts["stage"];
  investors: string;
  lead_investors: string;
  announced_date: string | null;
  article_id: number | null;
  source_url: string;
  source_articles: string;
  status: FundingStatus;
  superseded_by: number | null;
  updated_at: number;
  identity_confirmed: number;
  identity_json: string | null;
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

const COLUMNS = `company_name, company_key, round_name, round_key, amount, currency,
  amount_micros, valuation, valuation_micros, sector, stage, investors,
  lead_investors, announced_date, article_id, source_url, source_articles,
  status, superseded_by, correction_reason, created_at, updated_at, identity_confirmed, identity_json`;

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
  identityConfirmed?: number;
  identityJson?: string | null;
}

const statement = fundingStatement;

interface CurrentArticle {
  id: number;
  bodySha: string;
  application?: ObservationApplication;
}
function approvalGuard(article?: CurrentArticle): SQL {
  return article
    ? sql`EXISTS (SELECT 1 FROM articles a
    WHERE a.id = ${article.id} AND a.body_sha = ${article.bodySha}
      AND ${approvedArticleWhere})`
    : sql`1`;
}

function unappliedGuard(
  _companyKey: string,
  _roundKey: string,
  article?: CurrentArticle,
): SQL {
  return fundingDecisionGuard(article?.application);
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
      'pending_review', NULL, ${r.correctionReason}, ${now}, ${now}, ${r.identityConfirmed ?? 0}, ${r.identityJson ?? null}
    WHERE ${gated ? sql`changes() = 1` : sql`1`} AND ${approvalGuard(article)} AND ${fundingDecisionGuard(article?.application)}
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
      .prepare("SELECT key FROM settings WHERE key IN (?1,?2)")
      .bind(
        completionKey,
        `funding:done:${article.id}:funding-v1:${article.body_sha}`,
      )
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
    article.published_at === null
      ? null
      : new Date(article.published_at).toISOString().slice(0, 10);

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

  // Validate the complete response before any capture or financial side effect.
  for (const payload of parsed.rounds) validateFundingEvidence(payload, body);
  const captured = [];
  for (const [index, payload] of parsed.rounds.entries()) {
    captured.push(
      await captureFundingObservation(
        deps.db,
        article.id,
        article.body_sha,
        FUNDING_PROMPT_VERSION,
        index,
        payload,
        body,
        deps.now(),
      ),
    );
  }
  const out = { inserted: 0, merged: 0, superseded: 0, ignored: 0 };
  for (const observation of captured)
    out[
      await applyFundingObservation(
        deps.db,
        deps.bodies,
        observation.id,
        observation.decision_revision,
        deps.now(),
      )
    ]++;
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

/** A stale queue message never chooses a newer decision or recomputes its stable target. */
export async function applyFundingObservation(
  db: D1Database,
  bodies: R2Bucket,
  id: string,
  expectedRevision: number,
  now: number,
): Promise<"inserted" | "merged" | "superseded" | "ignored"> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const observation = await readFundingObservation(db, id);
    if (
      !observation ||
      observation.decision_revision !== expectedRevision ||
      observation.state !== "ready" ||
      !observation.resolution_json
    )
      return "ignored";
    const identity: ConfirmedFundingIdentity = JSON.parse(
      observation.resolution_json,
    );
    const application: ObservationApplication = {
      id,
      revision: expectedRevision,
      companyKey: identity.companyKey,
      roundKey: identity.roundKey,
    };
    const current: CurrentArticle = {
      id: observation.article_id,
      bodySha: observation.body_sha,
      application,
    };
    await assertCurrentApproval(db, current);
    const article = await db
      .prepare("SELECT canonical_url,title FROM articles WHERE id=?1")
      .bind(current.id)
      .first<{ canonical_url: string; title: string }>();
    const body = await bodies.get(`bodies/${current.id}/${current.bodySha}.md`);
    if (!article || !body) throw new Error("Approved funding body missing");
    const payload = observationPayload(observation);
    validateFundingEvidence(payload, await body.text());
    const next = reportedFundingFacts(payload, identity);
    const existing = await db
      .prepare(
        `SELECT * FROM funding_rounds WHERE company_key=?1 AND round_key=?2 AND superseded_by IS NULL`,
      )
      .bind(identity.companyKey, identity.roundKey)
      .first<FundingRow>();
    const source: FundingSourceArticle = {
      articleId: current.id,
      bodySha: current.bodySha,
      url: article.canonical_url,
      title: article.title,
      seenAt: now,
      observationId: id,
      decisionRevision: expectedRevision,
    };
    if (existing?.status === "rejected") {
      // Target was rejected; choose a reviewed target.
      await holdFundingObservation(db, application, now);
      return "ignored";
    }
    if (
      existing &&
      identity.source === "automatic" &&
      !payload.correctionPatch.amount &&
      next.amount !== null &&
      existing.amount !== null &&
      (next.amount !== existing.amount || next.currency !== existing.currency)
    ) {
      // Conflicting native amount/currency requires human confirmation.
      await holdFundingObservation(db, application, now);
      return "ignored";
    }
    const base: FundingFacts = existing
      ? {
          companyName: existing.company_name,
          roundName: existing.round_name,
          amount: existing.amount ?? next.amount,
          currency:
            existing.amount === null ? next.currency : existing.currency,
          valuation: existing.valuation ?? next.valuation,
          sector: existing.sector,
          stage: existing.stage,
          announcedDate: existing.announced_date ?? next.announcedDate,
          investors: mergeNames(
            parseStrings(existing.investors),
            next.investors,
          ),
          leadInvestors: mergeNames(
            parseStrings(existing.lead_investors),
            next.leadInvestors,
          ),
        }
      : next;
    if (
      existing &&
      identity.source === "manual" &&
      next.amount !== null &&
      !payload.correctionPatch.amount
    ) {
      base.amount = next.amount;
      base.currency = next.currency;
    }
    const facts = applyFundingPatch(base, payload.correctionPatch);
    const explicitChange = JSON.stringify(facts) !== JSON.stringify(base);
    const oldSources = existing ? parseSources(existing.source_articles) : [];
    const sources = [
      ...oldSources.filter((source) => source.articleId !== current.id),
      source,
    ];
    const version: NewRow = {
      ...facts,
      companyKey: identity.companyKey,
      roundKey: identity.roundKey,
      amountMicros:
        facts.amount === null
          ? null
          : convertToMicroUsd(facts.amount, facts.currency),
      valuationMicros:
        facts.valuation === null
          ? null
          : convertToMicroUsd(facts.valuation, facts.currency),
      articleId: existing?.article_id ?? current.id,
      sourceUrl: existing?.source_url ?? article.canonical_url,
      sources,
      correctionReason: existing
        ? (payload.correctionReason ??
          `Amount revised per ${article.canonical_url}`)
        : null,
      identityConfirmed: 1,
      identityJson: JSON.stringify({
        ...identity,
        companyName: facts.companyName,
        roundName: facts.roundName,
        announcedDate: facts.announcedDate,
      }),
    };
    if (!existing) {
      const [inserted] = await db.batch([
        insertStatement(db, version, now, current),
        fundingReceiptStatement(db, application, now),
      ]);
      if (inserted.meta.changes === 1) return "inserted";
      continue;
    }
    const factChanged =
      existing.identity_confirmed !== 1 ||
      facts.amount !== existing.amount ||
      facts.currency !== existing.currency ||
      facts.valuation !== existing.valuation ||
      facts.announcedDate !== existing.announced_date ||
      facts.companyName !== existing.company_name ||
      facts.roundName !== existing.round_name ||
      facts.sector !== existing.sector ||
      facts.stage !== existing.stage ||
      JSON.stringify(facts.investors) !== existing.investors ||
      JSON.stringify(facts.leadInvestors) !== existing.lead_investors;
    if (
      factChanged &&
      (existing.status === "published" ||
        explicitChange ||
        (existing.amount !== null &&
          (facts.amount !== existing.amount ||
            facts.currency !== existing.currency)))
    ) {
      if (
        await supersedeFundingRound(
          db,
          existing.id,
          version,
          now,
          existing,
          current,
        )
      )
        return "superseded";
      continue;
    }
    const [changed] = await db.batch([
      statement(
        db,
        sql`UPDATE funding_rounds SET source_articles=${JSON.stringify(sources)},updated_at=${now},
      investors=${JSON.stringify(facts.investors)},lead_investors=${JSON.stringify(facts.leadInvestors)},amount=${facts.amount},currency=${facts.currency},amount_micros=${version.amountMicros},
      valuation=${facts.valuation},valuation_micros=${version.valuationMicros},announced_date=${facts.announcedDate},identity_confirmed=1,identity_json=${version.identityJson}
      WHERE ${expectedRow(existing)} AND ${approvalGuard(current)} AND ${unappliedGuard(identity.companyKey, identity.roundKey, current)}`,
      ),
      fundingReceiptStatement(db, application, now),
    ]);
    if (changed.meta.changes === 1) return "merged";
  }
  throw new Error("Funding decision changed concurrently; retry");
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
  row = {
    ...row,
    identityConfirmed: row.identityConfirmed ?? old.identity_confirmed,
    identityJson: row.identityJson ?? old.identity_json,
  };
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
    ...(article?.application
      ? [fundingReceiptStatement(db, article.application, now)]
      : []),
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
