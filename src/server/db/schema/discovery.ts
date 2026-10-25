import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { industries } from "./industries";

export const discoveryRuns = sqliteTable(
  "discovery_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    industryId: integer("industry_id")
      .notNull()
      .references(() => industries.id),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed", "skipped"],
    })
      .notNull()
      .default("pending"),
    searchQueries: text("search_queries").notNull().default("[]"),
    candidatesFound: integer("candidates_found").notNull().default(0),
    candidatesAdded: integer("candidates_added").notNull().default(0),
    candidatesAutoEnabled: integer("candidates_auto_enabled")
      .notNull()
      .default(0),
    costMicros: integer("cost_micros").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("discovery_runs_industry_idx").on(t.industryId),
    index("discovery_runs_status_idx").on(t.status),
    index("discovery_runs_created_at_idx").on(t.createdAt),
    check(
      "discovery_runs_status_check",
      sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'skipped')`,
    ),
  ],
);

export const sourceCandidates = sqliteTable(
  "source_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").references(() => discoveryRuns.id),
    industryId: integer("industry_id")
      .notNull()
      .references(() => industries.id),
    name: text("name").notNull().default(""),
    feedUrl: text("feed_url").notNull(),
    siteDomain: text("site_domain"),
    kind: text("kind", { enum: ["rss", "html"] })
      .notNull()
      .default("rss"),
    fetchRung: integer("fetch_rung"),
    sampleUrls: text("sample_urls").notNull().default("[]"),
    sampleScores: text("sample_scores").notNull().default("[]"),
    avgScore: integer("avg_score"),
    requiresBrowser: integer("requires_browser").notNull().default(0),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "auto_enabled"],
    })
      .notNull()
      .default("pending"),
    rejectionReason: text("rejection_reason"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("source_candidates_industry_feed_unique").on(
      t.industryId,
      t.feedUrl,
    ),
    index("source_candidates_industry_idx").on(t.industryId),
    index("source_candidates_status_idx").on(t.status),
    index("source_candidates_run_id_idx").on(t.runId),
    check("source_candidates_kind_check", sql`${t.kind} IN ('rss', 'html')`),
    check(
      "source_candidates_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'auto_enabled')`,
    ),
    check(
      "source_candidates_requires_browser_check",
      sql`${t.requiresBrowser} IN (0, 1)`,
    ),
  ],
);
