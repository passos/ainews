import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { industries } from "./industries";

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    industryId: integer("industry_id")
      .notNull()
      .references(() => industries.id),
    title: text("title").notNull(),
    /** +1 whenever the set of approved articles changes (architecture §6). */
    revision: integer("revision").notNull().default(0),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    /** Epoch milliseconds. */
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("events_industry_created_at_idx").on(t.industryId, t.createdAt),
  ],
);
