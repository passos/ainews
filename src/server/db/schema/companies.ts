import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 10-digit zero-padded CIK string, e.g. "0000320193". */
    cik: text("cik").notNull(),
    /** Stock ticker symbol, uppercase, e.g. "AAPL". */
    ticker: text("ticker").notNull(),
    /** Company legal name, e.g. "Apple Inc.". */
    name: text("name").notNull(),
    /** 1 if actively tracked, 0 if paused. */
    tracked: integer("tracked").notNull().default(1),
    /** Epoch milliseconds when filings were last checked. */
    lastPolledAt: integer("last_polled_at"),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    /** Epoch milliseconds. */
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    unique("companies_cik_unique").on(t.cik),
    unique("companies_ticker_unique").on(t.ticker),
    index("companies_tracked_idx").on(t.tracked),
  ],
);
