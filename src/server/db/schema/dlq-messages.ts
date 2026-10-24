import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const dlqMessages = sqliteTable("dlq_messages", {
  id: text("id").primaryKey(),
  kind: text("kind"),
  bodyJson: text("body_json").notNull(),
  attempts: integer("attempts").notNull(),
  receivedAt: integer("received_at").notNull(),
  replayedAt: integer("replayed_at"),
});
