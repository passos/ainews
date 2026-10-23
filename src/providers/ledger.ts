// Model call ledger `llm_calls` (architecture §6).
//
//   pending ──┐
//   failed ───┼─ acquire ─> in_flight ─ markSent ─> (request) ─┬─> completed
//   (attempt < 3)           │                                  └─> failed
//                           ├─ lease expired, sent_at NULL: acquire again
//                           └─ lease expired, sent_at set:  markUnknown ─> unknown
//
// Every transition is a conditional UPDATE; `attempt` is the fencing token
// that tells the lease holder whether the row is still its own. The promise
// is "never start the same call twice, and recover", not "pay exactly once".
import type { Channel } from "./defaults";

export const LEASE_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 3;

export type AcquireOutcome =
  | { kind: "acquired"; attempt: number }
  | { kind: "completed"; model: string; responseJson: string }
  | { kind: "in_progress" }
  | { kind: "exhausted"; error: string | null }
  | { kind: "unknown" };

interface Row {
  status: string;
  attempt: number;
  lease_expires_at: number | null;
  sent_at: number | null;
  model: string;
  response_json: string | null;
  error: string | null;
}

function readRow(db: D1Database, logicalKey: string): Promise<Row | null> {
  return db
    .prepare(
      `SELECT status, attempt, lease_expires_at, sent_at, model, response_json, error
       FROM llm_calls WHERE logical_key = ?1`,
    )
    .bind(logicalKey)
    .first<Row>();
}

/** The stored result of a completed call, or null. */
export async function findCompleted(
  db: D1Database,
  logicalKey: string,
): Promise<{ model: string; responseJson: string } | null> {
  const row = await readRow(db, logicalKey);
  if (row?.status !== "completed" || row.response_json === null) return null;
  return { model: row.model, responseJson: row.response_json };
}

/** Creates the row if new, then tries to take the lease. */
export async function acquire(
  db: D1Database,
  args: {
    logicalKey: string;
    slot: string;
    model: string;
    channel: Channel;
    now: number;
  },
): Promise<AcquireOutcome> {
  const { logicalKey, now } = args;
  const [, update] = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO llm_calls
           (logical_key, slot, model, channel, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)`,
      )
      .bind(logicalKey, args.slot, args.model, args.channel, now),
    db
      .prepare(
        `UPDATE llm_calls
         SET status = 'in_flight', lease_expires_at = ?2, attempt = attempt + 1,
             sent_at = NULL, model = ?3, channel = ?4, updated_at = ?5
         WHERE logical_key = ?1
           AND ((status IN ('pending', 'failed') AND attempt < ?6)
             OR (status = 'in_flight' AND lease_expires_at < ?5 AND sent_at IS NULL))`,
      )
      .bind(
        logicalKey,
        now + LEASE_MS,
        args.model,
        args.channel,
        now,
        MAX_ATTEMPTS,
      ),
  ]);

  const row = await readRow(db, logicalKey);
  if (row === null) throw new Error(`llm_calls row ${logicalKey} vanished`);
  if (update.meta.changes === 1) {
    return { kind: "acquired", attempt: row.attempt };
  }
  switch (row.status) {
    case "completed":
      if (row.response_json === null) break;
      return {
        kind: "completed",
        model: row.model,
        responseJson: row.response_json,
      };
    case "failed":
      if (row.attempt >= MAX_ATTEMPTS) {
        return { kind: "exhausted", error: row.error };
      }
      break;
    case "in_flight":
      if (
        row.lease_expires_at !== null &&
        row.lease_expires_at < now &&
        row.sent_at !== null
      ) {
        return (await markUnknown(db, { logicalKey, now }))
          ? { kind: "unknown" }
          : { kind: "in_progress" };
      }
      break;
    case "unknown":
      return { kind: "unknown" };
  }
  // Live lease, or the row changed between the UPDATE and the read.
  return { kind: "in_progress" };
}

/**
 * Records that the request is about to go out. False: the lease was lost
 * (someone took over), so the caller must not send.
 */
export async function markSent(
  db: D1Database,
  args: {
    logicalKey: string;
    attempt: number;
    now: number;
    requestJson: string;
    estimatedMicros: number;
    budgetDay: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE llm_calls
       SET sent_at = ?3, request_json = ?4, estimated_micros = ?5,
           budget_day = ?6, updated_at = ?3
       WHERE logical_key = ?1 AND attempt = ?2 AND status = 'in_flight'`,
    )
    .bind(
      args.logicalKey,
      args.attempt,
      args.now,
      args.requestJson,
      args.estimatedMicros,
      args.budgetDay,
    )
    .run();
  return result.meta.changes === 1;
}

/**
 * Budget refused the call: back to `failed` without using up an attempt, so
 * the row neither blocks later calls nor counts towards MAX_ATTEMPTS.
 */
export function rejectForBudget(
  db: D1Database,
  args: { logicalKey: string; attempt: number; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE llm_calls
       SET status = 'failed', attempt = attempt - 1, error = 'budget_exceeded',
           lease_expires_at = NULL, updated_at = ?3
       WHERE logical_key = ?1 AND attempt = ?2 AND status = 'in_flight'`,
    )
    .bind(args.logicalKey, args.attempt, args.now);
}

/**
 * The result arrived. Also matches `unknown`: a late result resolves a row
 * that a later caller gave up on.
 */
export function complete(
  db: D1Database,
  args: {
    logicalKey: string;
    attempt: number;
    now: number;
    responseJson: string;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE llm_calls
       SET status = 'completed', response_json = ?4, input_tokens = ?5,
           output_tokens = ?6, cost_micros = ?7, error = NULL,
           lease_expires_at = NULL, updated_at = ?3
       WHERE logical_key = ?1 AND attempt = ?2
         AND status IN ('in_flight', 'unknown')`,
    )
    .bind(
      args.logicalKey,
      args.attempt,
      args.now,
      args.responseJson,
      args.inputTokens,
      args.outputTokens,
      args.costMicros,
    );
}

export function fail(
  db: D1Database,
  args: {
    logicalKey: string;
    attempt: number;
    now: number;
    error: string;
    responseJson: string | null;
    costMicros: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE llm_calls
       SET status = 'failed', error = ?4, response_json = ?5, cost_micros = ?6,
           lease_expires_at = NULL, updated_at = ?3
       WHERE logical_key = ?1 AND attempt = ?2
         AND status IN ('in_flight', 'unknown')`,
    )
    .bind(
      args.logicalKey,
      args.attempt,
      args.now,
      args.error.slice(0, 2000),
      args.responseJson,
      args.costMicros,
    );
}

/**
 * Sent, lease expired, no result: the request may or may not have run.
 * Do not resend and keep the reservation; the admin reconciles it (#9).
 */
export async function markUnknown(
  db: D1Database,
  args: { logicalKey: string; now: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE llm_calls SET status = 'unknown', updated_at = ?2
       WHERE logical_key = ?1 AND status = 'in_flight'
         AND lease_expires_at < ?2 AND sent_at IS NOT NULL`,
    )
    .bind(args.logicalKey, args.now)
    .run();
  return result.meta.changes === 1;
}
