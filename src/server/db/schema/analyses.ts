import {
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { articles } from "./articles";

/** One Jev analysis per article and prompt version (#7). */
export const analyses = sqliteTable(
  "analyses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id),
    promptVersion: text("prompt_version").notNull(),
    /** JSON `{ sig, nov, cred, reson, act }`: 0-10, after the noise caps. */
    scores: text("scores").notNull(),
    contentType: text("content_type").notNull(),
    /** JSON object: label key -> option, or "uncertain". */
    evidenceTags: text("evidence_tags").notNull(),
    /** 0-100, always an integer (the column was created as real). */
    totalScore: real("total_score").notNull(),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    /** Jev probability of the prefilter choice "relevant". */
    prefilterRelevant: real("prefilter_relevant"),
    /** 0 or 1. */
    prefilterPass: integer("prefilter_pass").notNull().default(0),
    category: text("category"),
    /** Noise choice; its caps were applied to `scores`. */
    noiseKind: text("noise_kind"),
    /** 0 or 1: prefilter passed and total_score >= the select threshold. */
    selected: integer("selected").notNull().default(0),
    /** `write` slot output; null if not selected or the write failed. */
    titleEn: text("title_en"),
    summaryEn: text("summary_en"),
    /** JSON: the Jev answers as parsed. */
    jevRaw: text("jev_raw"),
  },
  (t) => [
    unique("analyses_article_prompt_unique").on(t.articleId, t.promptVersion),
  ],
);
