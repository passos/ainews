import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { articles } from "./articles";

export const reviews = sqliteTable(
  "reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id),
    /**
     * Not null: SQLite unique constraints do not block duplicate NULLs.
     * Summary-only articles use the sha256 of the summary text.
     */
    bodySha: text("body_sha").notNull(),
    decision: text("decision", { enum: ["approved", "rejected"] }).notNull(),
    /** "auto" or the reviewer's email. */
    reviewer: text("reviewer").notNull(),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("reviews_article_body_unique").on(t.articleId, t.bodySha),
    check(
      "reviews_decision_check",
      sql`${t.decision} IN ('approved', 'rejected')`,
    ),
  ],
);
