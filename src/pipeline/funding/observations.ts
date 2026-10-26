import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  automaticFundingIdentity,
  validateFundingEvidence,
} from "../../lib/funding/identity";
import {
  extractedRoundSchema,
  fundingResolutionSchema,
  type ConfirmedFundingIdentity,
  type ExtractedRound,
} from "../../lib/funding/types";

export interface FundingObservation {
  id: string;
  article_id: number;
  body_sha: string;
  prompt_version: string;
  item_index: number;
  payload_json: string;
  resolution_json: string | null;
  decision_revision: number;
  state: "unresolved" | "ready" | "applied" | "rejected";
}
export interface ObservationApplication {
  id: string;
  revision: number;
  companyKey: string;
  roundKey: string;
}
export function fundingStatement(
  db: D1Database,
  query: SQL,
): D1PreparedStatement {
  const compiled = new SQLiteSyncDialect().sqlToQuery(query);
  return db.prepare(compiled.sql).bind(...compiled.params);
}
export async function readFundingObservation(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM funding_observations WHERE id=?1")
    .bind(id)
    .first<FundingObservation>();
}

async function automaticResolution(
  db: D1Database,
  payload: ExtractedRound,
): Promise<ConfirmedFundingIdentity | null> {
  const identity = automaticFundingIdentity(payload);
  if (
    !identity ||
    (payload.reportedFacts.amount?.value != null &&
      !payload.reportedFacts.currency &&
      !payload.correctionPatch.currency)
  )
    return null;
  const patch = payload.correctionPatch;
  const identityChange =
    patch.companyName || patch.roundName || patch.announcedDate;
  if (identityChange && !payload.identity.sameEventEvidence) return null;
  const shared = await db
    .prepare(
      `SELECT company_key FROM funding_rounds
    WHERE identity_confirmed=1 AND json_extract(identity_json,'$.companyHost')=?1 AND company_key!=?2 LIMIT 1`,
    )
    .bind(identity.companyHost, identity.companyKey)
    .first();
  if (shared) return null;
  if (!payload.identity.sameEventEvidence) return identity;
  const { results } = await db
    .prepare(
      `SELECT identity_json FROM funding_rounds
    WHERE company_key=?1 AND superseded_by IS NULL AND identity_confirmed=1
      AND json_extract(identity_json,'$.concreteRound')=?2 LIMIT 2`,
    )
    .bind(identity.companyKey, identity.concreteRound)
    .all<{ identity_json: string }>();
  return results.length === 1
    ? { ...JSON.parse(results[0].identity_json), source: "automatic" }
    : null;
}

/** Unique capture never updates the model payload or a prior decision. */
export async function captureFundingObservation(
  db: D1Database,
  articleId: number,
  bodySha: string,
  promptVersion: string,
  itemIndex: number,
  payload: ExtractedRound,
  body: string,
  now: number,
): Promise<FundingObservation> {
  validateFundingEvidence(payload, body);
  const id = `${articleId}:${bodySha}:${promptVersion}:${itemIndex}`;
  const prior = await readFundingObservation(db, id);
  if (prior) return prior;
  const resolution = await automaticResolution(db, payload);
  const revision = resolution ? 1 : 0;
  const state = resolution ? "ready" : "unresolved";
  await db
    .prepare(
      `INSERT INTO funding_observations
    (id,article_id,body_sha,prompt_version,item_index,payload_json,resolution_json,decision_revision,state,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10) ON CONFLICT DO NOTHING`,
    )
    .bind(
      id,
      articleId,
      bodySha,
      promptVersion,
      itemIndex,
      JSON.stringify(payload),
      resolution ? JSON.stringify(resolution) : null,
      revision,
      state,
      now,
    )
    .run();
  const captured = await readFundingObservation(db, id);
  if (!captured) throw new Error("Funding observation capture failed");
  return captured;
}

/** Exposed as a statement so C can compose reassignment and both financial snapshots in one batch. */
export function fundingDecisionStatement(
  db: D1Database,
  id: string,
  expectedRevision: number,
  target: ConfirmedFundingIdentity | null,
  reason: string,
  now: number,
): D1PreparedStatement {
  if (!reason.trim()) throw new Error("A funding decision requires a reason");
  const revision = expectedRevision + 1;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error("Invalid decision revision");
  const resolution = target
    ? { ...fundingResolutionSchema.parse(target), source: "manual" as const }
    : null;
  return fundingStatement(
    db,
    sql`UPDATE funding_observations
    SET resolution_json=${resolution ? JSON.stringify(resolution) : null},decision_revision=${revision},
      state=${resolution ? "ready" : "rejected"},updated_at=${now}
    WHERE id=${id} AND decision_revision=${expectedRevision}
      AND state IN ('unresolved','ready')`,
  );
}
export async function decideFundingObservation(
  db: D1Database,
  id: string,
  expectedRevision: number,
  target: ConfirmedFundingIdentity | null,
  reason: string,
  now: number,
): Promise<boolean> {
  const result = await fundingDecisionStatement(
    db,
    id,
    expectedRevision,
    target,
    reason,
    now,
  ).run();
  return result.meta.changes === 1;
}

/** This guard belongs on financial writes, in the same database snapshot. */
export function fundingDecisionGuard(
  application?: ObservationApplication,
): SQL {
  if (!application) return sql`1`;
  return sql`EXISTS (SELECT 1 FROM funding_observations o WHERE o.id=${application.id}
    AND o.decision_revision=${application.revision} AND o.state='ready'
    AND json_extract(o.resolution_json,'$.companyKey')=${application.companyKey}
    AND json_extract(o.resolution_json,'$.roundKey')=${application.roundKey})`;
}
export function fundingReceiptStatement(
  db: D1Database,
  application: ObservationApplication,
  now: number,
): D1PreparedStatement {
  return fundingStatement(
    db,
    sql`UPDATE funding_observations SET state='applied',updated_at=${now}
    WHERE id=${application.id} AND changes()=1 AND ${fundingDecisionGuard(application)}`,
  );
}
export async function holdFundingObservation(
  db: D1Database,
  application: ObservationApplication,
  now: number,
) {
  await fundingStatement(
    db,
    sql`UPDATE funding_observations SET state='unresolved',updated_at=${now}
    WHERE id=${application.id} AND ${fundingDecisionGuard(application)}`,
  ).run();
}
export function observationPayload(row: FundingObservation): ExtractedRound {
  return extractedRoundSchema.parse(JSON.parse(row.payload_json));
}
