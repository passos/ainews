// Daily budget per channel (architecture §6), in micro-USD. A call reserves
// its estimated cost in the same batch() that marks its ledger row as sent
// (ledger.ts `reserveAndMarkSent`), so a reservation always belongs to one
// sent row. The batch that records the result settles it. AI Gateway spend
// limits are only an outer backstop.
//
// No runtime imports here: scripts/smoke-models.ts loads this file in Node.
import type { Price } from "./defaults";

/** UTC `YYYY-MM-DD`. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Every amount written to `budgets` passes here: a negative or fractional
 * amount would move the cap. */
export function assertMicros(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative integer, got ${value}`,
    );
  }
}

/**
 * Price is integer micro-USD per 1M tokens. Integer products and sums, one
 * rounding up at the end: 1,500 Jev input tokens cost exactly 63.
 */
export function costMicros(
  price: Price,
  inputTokens: number,
  outputTokens: number,
): number {
  const micros = Math.ceil(
    (inputTokens * price.in + outputTokens * price.out) / 1_000_000,
  );
  assertMicros(micros, "cost");
  return micros;
}

/** Creates the day's row with `capMicros`; an existing row keeps its cap. */
export function ensureDay(
  db: D1Database,
  args: { day: string; channel: string; capMicros: number },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT OR IGNORE INTO budgets (day, channel, cap_micros) VALUES (?1, ?2, ?3)",
    )
    .bind(args.day, args.channel, args.capMicros);
}

/**
 * Moves the reservation of one sent call to spent, at `actualMicros`. Only
 * takes effect while that call's row (`logicalKey`, `attempt`) is still
 * `in_flight` or `unknown` and holds this reservation, so put it before the
 * statement that ends the row in the same batch(). A second or late result
 * changes nothing.
 */
export function settle(
  db: D1Database,
  args: {
    logicalKey: string;
    attempt: number;
    day: string;
    channel: string;
    reservedMicros: number;
    actualMicros: number;
  },
): D1PreparedStatement {
  assertMicros(args.reservedMicros, "reservedMicros");
  assertMicros(args.actualMicros, "actualMicros");
  return db
    .prepare(
      `UPDATE budgets SET reserved_micros = reserved_micros - ?1,
         spent_micros = spent_micros + ?2
       WHERE day = ?3 AND channel = ?4
         AND EXISTS (
           SELECT 1 FROM llm_calls
           WHERE logical_key = ?5 AND attempt = ?6
             AND status IN ('in_flight', 'unknown') AND sent_at IS NOT NULL
             AND budget_day = ?3 AND channel = ?4 AND estimated_micros = ?1)`,
    )
    .bind(
      args.reservedMicros,
      args.actualMicros,
      args.day,
      args.channel,
      args.logicalKey,
      args.attempt,
    );
}
