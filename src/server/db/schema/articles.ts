import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { industries } from "./industries";
import { sources } from "./sources";

export const articles = sqliteTable(
  "articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id),
    industryId: integer("industry_id")
      .notNull()
      .references(() => industries.id),
    /** Unique across all industries (architecture §9, known limit). */
    canonicalUrl: text("canonical_url").notNull().unique(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    /** Plain text from the feed, at most 4,000 characters. */
    summary: text("summary"),
    /** The date string as the source wrote it. */
    publishedRaw: text("published_raw"),
    /** Epoch milliseconds, from the source. */
    publishedAt: integer("published_at"),
    /** Epoch milliseconds. */
    fetchedAt: integer("fetched_at").notNull(),
    stage: text("stage", {
      enum: ["collected", "body_ready", "analyzed", "grouped", "dropped"],
    })
      .notNull()
      .default("collected"),
    /** Epoch milliseconds. */
    stageUpdatedAt: integer("stage_updated_at").notNull(),
    /** Fetch ladder rung actually used for this article. */
    fetchRung: integer("fetch_rung"),
    /** sha256 of the current body version in R2. */
    bodySha: text("body_sha"),
    /** 'full': a fetched body; 'summary': only the feed summary (#6). */
    bodyKind: text("body_kind", { enum: ["full", "summary"] }),
    /** 1 if the body was cut at 2 MB. */
    bodyTruncated: integer("body_truncated").notNull().default(0),
    /** Epoch milliseconds. */
    bodyFetchedAt: integer("body_fetched_at"),
    /** Times the backfill cron sent this row again (architecture §5). */
    requeueCount: integer("requeue_count").notNull().default(0),
    /** Admin override of the public title; wins over the analysis (#10). */
    titleOverride: text("title_override"),
    /** Admin override of the public summary; wins over the analysis (#10). */
    summaryOverride: text("summary_override"),
  },
  (t) => [
    // Backfill scans: "articles stuck in stage X since before T".
    index("articles_stage_idx").on(t.stage, t.stageUpdatedAt),
    // Public pages: "newest approved articles of one section". The sort
    // expression is the same as NEWEST_FIRST in publication/articles.ts.
    index("articles_industry_newest_idx").on(
      t.industryId,
      sql`COALESCE(published_at, fetched_at) DESC`,
      sql`id DESC`,
    ),
    check(
      "articles_stage_check",
      sql`${t.stage} IN ('collected', 'body_ready', 'analyzed', 'grouped', 'dropped')`,
    ),
    check(
      "articles_body_kind_check",
      sql`${t.bodyKind} IN ('full', 'summary')`,
    ),
  ],
);
