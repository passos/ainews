import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { articles } from "./articles";
export const fundingObservations = sqliteTable(
  "funding_observations",
  {
    id: text("id").primaryKey(),
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id),
    bodySha: text("body_sha").notNull(),
    promptVersion: text("prompt_version").notNull(),
    itemIndex: integer("item_index").notNull(),
    payloadJson: text("payload_json").notNull(),
    resolutionJson: text("resolution_json"),
    decisionRevision: integer("decision_revision").notNull().default(0),
    state: text("state", {
      enum: ["unresolved", "ready", "applied", "rejected"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("funding_observations_state_idx").on(table.state, table.updatedAt),
    check(
      "funding_observations_state_check",
      sql`${table.state} IN ('unresolved','ready','applied','rejected')`,
    ),
  ],
);
