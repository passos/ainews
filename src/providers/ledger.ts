// Model call ledger `llm_calls` (architecture §6).
//
//   pending ──┐                     reserveAndMarkSent (one batch)
//   failed ───┼─ acquire ─> in_flight ─┬─> sent ─> (request) ─┬─> completed
//   (failures < 3)          │          │                      └─> failed +1
//                           │          ├─> failed (budget refused, +0)
//                           │          └─> failed +1 (abandon: error before send)
//                           ├─ lease expired, sent_at NULL:  failed +1
//                           └─ lease expired, sent_at set:   markUnknown ─> unknown
//
//   +1: `failures` + 1. `failed` with failures = 3 is exhausted.
//
// Every transition is a conditional UPDATE. `attempt` is the fencing token:
// each acquire adds 1 and it never decreases, so an attempt number names one
// lease holder only, and a holder whose row was taken over matches nothing.
// `failures` counts real failures and decides when a key is exhausted; a
// budget rejection does not count. The promise is "never start the same call
// twice, and recover", not "pay exactly once".
//
// Budget invariant: a reservation exists if and only if one row has
// `sent_at` set and records its `(budget_day, channel, estimated_micros)`.
// Reserving and marking sent commit together; settling happens in the batch
// that ends the row, and only while the row is still `in_flight`/`unknown`.
import { assertMicros, ensureDay } from "./budget";
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
  failures: number;
  lease_expires_at: number | null;
  sent_at: number | null;
  model: string;
  response_json: string | null;
  error: string | null;
}

function readRow(db: D1Database, logicalKey: string): Promise<Row | null> {
  return db
    .prepare(
      `SELECT status, attempt, failures, lease_expires_at, sent_at, model,
         response_json, error
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
  const [, , update] = await db.batch<{ attempt: number }>([
    db
      .prepare(
        `INSERT OR IGNORE INTO llm_calls
           (logical_key, slot, model, channel, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)`,
      )
      .bind(logicalKey, args.slot, args.model, args.channel, now),
    // The holder of an expired, unsent lease went away: a real failure.
    db
      .prepare(
        `UPDATE llm_calls
         SET status = 'failed', failures = failures + 1,
             error = 'lease expired before the request was sent',
             lease_expires_at = NULL, updated_at = ?2
         WHERE logical_key = ?1 AND status = 'in_flight'
           AND lease_expires_at < ?2 AND sent_at IS NULL`,
      )
      .bind(logicalKey, now),
    // RETURNING: the attempt this UPDATE took, not whatever a later read sees.
    db
      .prepare(
        `UPDATE llm_calls
         SET status = 'in_flight', lease_expires_at = ?2, attempt = attempt + 1,
             sent_at = NULL, model = ?3, channel = ?4, updated_at = ?5
         WHERE logical_key = ?1 AND status IN ('pending', 'failed')
           AND failures < ?6
         RETURNING attempt`,
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

  const taken = update.results[0];
  if (taken !== undefined) return { kind: "acquired", attempt: taken.attempt };

  const row = await readRow(db, logicalKey);
  if (row === null) throw new Error(`llm_calls row ${logicalKey} vanished`);
  switch (row.status) {
    case "completed":
      if (row.response_json === null) break;
      return {
        kind: "completed",
        model: row.model,
        responseJson: row.response_json,
      };
    case "failed":
      if (row.failures >= MAX_ATTEMPTS) {
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

export type SendOutcome = "sent" | "over_budget" | "lost";

/**
 * In one batch: reserve `estimatedMicros` on the day's budget and record the
 * request as about to go out. Either both happen or neither does.
 *   "sent":        reserved and marked sent; the caller sends.
 *   "over_budget": the cap cannot cover the estimate. The row goes back to
 *                  `failed`; `failures` does not change.
 *   "lost":        the lease was lost (someone took over); nothing reserved.
 */
export async function reserveAndMarkSent(
  db: D1Database,
  args: {
    logicalKey: string;
    attempt: number;
    now: number;
    requestJson: string;
    estimatedMicros: number;
    budgetDay: string;
    channel: Channel;
    capMicros: number;
  },
): Promise<SendOutcome> {
  const { logicalKey, attempt, now, estimatedMicros, budgetDay, channel } =
    args;
  assertMicros(estimatedMicros, "estimatedMicros");
  const [, sent, reserved, rejected] = await db.batch([
    ensureDay(db, { day: budgetDay, channel, capMicros: args.capMicros }),
    // Marks sent only if the row is still this attempt's and the cap has room.
    db
      .prepare(
        `UPDATE llm_calls
         SET sent_at = ?3, request_json = ?4, estimated_micros = ?5,
             budget_day = ?6, updated_at = ?3
         WHERE logical_key = ?1 AND attempt = ?2 AND status = 'in_flight'
           AND sent_at IS NULL AND channel = ?7
           AND EXISTS (
             SELECT 1 FROM budgets
             WHERE day = ?6 AND channel = ?7
               AND reserved_micros + spent_micros + ?5 <= cap_micros)`,
      )
      .bind(
        logicalKey,
        attempt,
        now,
        args.requestJson,
        estimatedMicros,
        budgetDay,
        channel,
      ),
    // Reserves only if the statement just above marked the row sent:
    // changes() is that statement's row count. The EXISTS repeats the
    // row condition, so an earlier send of this attempt does not count.
    db
      .prepare(
        `UPDATE budgets SET reserved_micros = reserved_micros + ?1
         WHERE day = ?2 AND channel = ?3 AND changes() = 1
           AND reserved_micros + spent_micros + ?1 <= cap_micros
           AND EXISTS (
             SELECT 1 FROM llm_calls
             WHERE logical_key = ?4 AND attempt = ?5 AND status = 'in_flight'
               AND sent_at IS NOT NULL AND budget_day = ?2 AND channel = ?3
               AND estimated_micros = ?1)`,
      )
      .bind(estimatedMicros, budgetDay, channel, logicalKey, attempt),
    // Still ours and not sent: the budget refused. Not a failure.
    db
      .prepare(
        `UPDATE llm_calls
         SET status = 'failed', error = 'budget_exceeded',
             lease_expires_at = NULL, updated_at = ?3
         WHERE logical_key = ?1 AND attempt = ?2 AND status = 'in_flight'
           AND sent_at IS NULL`,
      )
      .bind(logicalKey, attempt, now),
  ]);
  if (sent.meta.changes !== reserved.meta.changes) {
    // Cannot happen while the two conditions above hold. Fail loudly: the
    // row is sent, so it becomes `unknown` and the admin reconciles it.
    throw new Error(`llm_calls ${logicalKey}: reservation and sent_at differ`);
  }
  if (sent.meta.changes === 1) return "sent";
  return rejected.meta.changes === 1 ? "over_budget" : "lost";
}

/**
 * Something failed after acquire and before the request went out. Counts as
 * a failure. No-op if the row was sent (it then has a reservation and
 * becomes `unknown` when the lease expires) or is no longer ours.
 */
export function abandon(
  db: D1Database,
  args: { logicalKey: string; attempt: number; now: number; error: string },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE llm_calls
       SET status = 'failed', failures = failures + 1, error = ?4,
           lease_expires_at = NULL, updated_at = ?3
       WHERE logical_key = ?1 AND attempt = ?2 AND status = 'in_flight'
         AND sent_at IS NULL`,
    )
    .bind(args.logicalKey, args.attempt, args.now, args.error.slice(0, 2000));
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

/** The request went out and failed (transport or parse). Counts as a failure. */
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
       SET status = 'failed', failures = failures + 1, error = ?4,
           response_json = ?5, cost_micros = ?6,
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
