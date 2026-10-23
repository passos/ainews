// Daily budget per channel (architecture §6), in micro-USD. A call reserves
// its estimated cost with one conditional UPDATE before it is sent, and
// settles (or releases) the reservation in the same batch() that records the
// result. AI Gateway spend limits are only an outer backstop.
import type { Price } from "./defaults";

/** UTC `YYYY-MM-DD`. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Price is micro-USD per token, so the product is micro-USD. */
export function costMicros(
  price: Price,
  inputTokens: number,
  outputTokens: number,
): number {
  return Math.ceil(inputTokens * price.in + outputTokens * price.out);
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

/** True if the reservation fits under the cap. False: do not call. */
export async function reserve(
  db: D1Database,
  args: { day: string; channel: string; micros: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE budgets SET reserved_micros = reserved_micros + ?1
       WHERE day = ?2 AND channel = ?3
         AND reserved_micros + spent_micros + ?1 <= cap_micros`,
    )
    .bind(args.micros, args.day, args.channel)
    .run();
  return result.meta.changes === 1;
}

/** Moves a reservation to spent, at the actual cost. */
export function settle(
  db: D1Database,
  args: {
    day: string;
    channel: string;
    reservedMicros: number;
    actualMicros: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE budgets SET reserved_micros = reserved_micros - ?1,
         spent_micros = spent_micros + ?2
       WHERE day = ?3 AND channel = ?4`,
    )
    .bind(args.reservedMicros, args.actualMicros, args.day, args.channel);
}

/** Drops a reservation for a call that cost nothing. */
export function release(
  db: D1Database,
  args: { day: string; channel: string; micros: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE budgets SET reserved_micros = reserved_micros - ?1
       WHERE day = ?2 AND channel = ?3`,
    )
    .bind(args.micros, args.day, args.channel);
}
