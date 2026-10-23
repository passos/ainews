import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON-encoded value. */
  value: text("value").notNull(),
  /** Epoch milliseconds. */
  updatedAt: integer("updated_at").notNull(),
});
