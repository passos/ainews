import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One row per real reader watch judge send, on the UTC day of the send
 * (#132). The daily cap counts rows of one `day`; the sweep deletes old days.
 */
export const readerWatchAdmissions = sqliteTable(
  "reader_watch_admissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    logicalKey: text("logical_key").notNull(),
    day: text("day").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("reader_watch_admissions_day_idx").on(t.day)],
);
