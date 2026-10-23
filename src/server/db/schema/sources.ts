import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { industries } from "./industries";

export const sources = sqliteTable(
  "sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    industryId: integer("industry_id")
      .notNull()
      .references(() => industries.id),
    name: text("name").notNull().default(""),
    feedUrl: text("feed_url").notNull(),
    siteDomain: text("site_domain"),
    kind: text("kind", { enum: ["rss", "html"] }).notNull(),
    status: text("status", { enum: ["active", "paused", "candidate"] })
      .notNull()
      .default("candidate"),
    /** Why the source was paused automatically; null otherwise. */
    pausedReason: text("paused_reason", { enum: ["failing", "stale"] }),
    intervalMinutes: integer("interval_minutes").notNull().default(60),
    /** Epoch milliseconds. 0 = due now. */
    nextFetchAt: integer("next_fetch_at").notNull().default(0),
    /** Offset for dates without a time zone, as "+hh:mm" or "-hh:mm". */
    utcOffset: text("utc_offset").notNull().default("+00:00"),
    /** JSON, see src/pipeline/collect/config.ts. */
    config: text("config").notNull().default("{}"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    /** Consecutive failed fetches. */
    failCount: integer("fail_count").notNull().default(0),
    /**
     * Consecutive successful fetches that found nothing new for this source.
     * empty_fetches * interval_minutes >= 30 days pauses it as 'stale'.
     */
    emptyFetches: integer("empty_fetches").notNull().default(0),
    /** Epoch milliseconds. */
    lastOkAt: integer("last_ok_at"),
    /** Epoch milliseconds. */
    lastFailedAt: integer("last_failed_at"),
    /** First 500 characters of the last error. */
    lastError: text("last_error"),
    /** Fetch ladder rung (0-3), set after the first probe. */
    fetchRung: integer("fetch_rung"),
    /** 0 or 1. */
    jinaEnabled: integer("jina_enabled").notNull().default(0),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("sources_industry_feed_unique").on(t.industryId, t.feedUrl),
    check("sources_kind_check", sql`${t.kind} IN ('rss', 'html')`),
    check(
      "sources_status_check",
      sql`${t.status} IN ('active', 'paused', 'candidate')`,
    ),
    check(
      "sources_paused_reason_check",
      sql`${t.pausedReason} IN ('failing', 'stale')`,
    ),
  ],
);
