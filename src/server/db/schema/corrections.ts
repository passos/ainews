import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const corrections = sqliteTable("corrections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Table name of the corrected row, for example "events". */
  targetType: text("target_type").notNull(),
  targetId: integer("target_id").notNull(),
  body: text("body").notNull(),
  /** Epoch milliseconds. */
  createdAt: integer("created_at").notNull(),
});
