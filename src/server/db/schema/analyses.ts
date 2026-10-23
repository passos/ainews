import {
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { articles } from "./articles";

export const analyses = sqliteTable(
  "analyses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id),
    promptVersion: text("prompt_version").notNull(),
    /** JSON: the five dimension scores. */
    scores: text("scores").notNull(),
    contentType: text("content_type").notNull(),
    /** JSON array. */
    evidenceTags: text("evidence_tags").notNull(),
    totalScore: real("total_score").notNull(),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("analyses_article_prompt_unique").on(t.articleId, t.promptVersion),
  ],
);
