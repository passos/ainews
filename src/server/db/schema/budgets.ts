import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Daily spend per channel, in micro-USD (1 USD = 1,000,000). Reserve and
 * settle SQL lives in src/providers/budget.ts. `channel` has no CHECK:
 * `jina` budgets share this table.
 */
export const budgets = sqliteTable(
  "budgets",
  {
    /** UTC YYYY-MM-DD. */
    day: text("day").notNull(),
    channel: text("channel").notNull(),
    capMicros: integer("cap_micros").notNull(),
    reservedMicros: integer("reserved_micros").notNull().default(0),
    spentMicros: integer("spent_micros").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.channel] })],
);
