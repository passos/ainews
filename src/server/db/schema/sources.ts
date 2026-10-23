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
    feedUrl: text("feed_url").notNull(),
    kind: text("kind", { enum: ["rss", "html"] }).notNull(),
    status: text("status", { enum: ["active", "paused", "candidate"] })
      .notNull()
      .default("candidate"),
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
  ],
);
