import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { articles } from "./articles";

export const fundingRounds = sqliteTable(
  "funding_rounds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyName: text("company_name").notNull(),
    companyKey: text("company_key").notNull(),
    roundName: text("round_name").notNull(),
    roundKey: text("round_key").notNull(),
    /** Native currency amount, null if undisclosed */
    amount: integer("amount"),
    /** ISO 4217 currency code, e.g. USD, EUR */
    currency: text("currency").notNull().default("USD"),
    /** Normalized amount in micro-USD (1 USD = 1,000,000) */
    amountMicros: integer("amount_micros"),
    /** Native valuation, null if undisclosed */
    valuation: integer("valuation"),
    /** Normalized valuation in micro-USD */
    valuationMicros: integer("valuation_micros"),
    /** Sector, e.g. ai_infrastructure, developer_tools, fintech, enterprise_saas, healthcare */
    sector: text("sector").notNull(),
    stage: text("stage", {
      enum: [
        "pre_seed",
        "seed",
        "series_a",
        "series_b",
        "series_c",
        "series_d_plus",
        "growth",
        "grant",
        "debt",
        "undisclosed",
      ],
    }).notNull(),
    /** JSON string array of participating investors */
    investors: text("investors").notNull().default("[]"),
    /** JSON string array of lead investors */
    leadInvestors: text("lead_investors").notNull().default("[]"),
    /** YYYY-MM-DD announced date */
    announcedDate: text("announced_date"),
    /** Article that first reported or triggered extraction */
    articleId: integer("article_id").references(() => articles.id),
    /** Canonical or source URL of the reporting article */
    sourceUrl: text("source_url").notNull(),
    /** JSON array of articles reporting this round: Array<{ articleId: number, url: string, title: string, seenAt: number }> */
    sourceArticles: text("source_articles").notNull().default("[]"),
    /** Editorial review status */
    status: text("status", {
      enum: ["published", "pending_review", "rejected"],
    })
      .notNull()
      .default("pending_review"),
    /** ID of the restating/superseding funding round when corrected, null if latest active round */
    supersededBy: integer("superseded_by").references(
      (): AnySQLiteColumn => fundingRounds.id,
    ),
    /** Human-readable explanation of why this round was superseded/corrected */
    correctionReason: text("correction_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("funding_rounds_active_unique")
      .on(t.companyKey, t.roundKey)
      .where(sql`superseded_by IS NULL`),
    index("funding_rounds_sector_idx").on(t.sector, t.status),
    index("funding_rounds_stage_idx").on(t.stage, t.status),
    index("funding_rounds_announced_date_idx").on(t.announcedDate, t.status),
    index("funding_rounds_superseded_idx").on(t.supersededBy),
    index("funding_rounds_article_id_idx").on(t.articleId),
    index("funding_rounds_status_idx").on(t.status),
    check(
      "funding_rounds_status_check",
      sql`${t.status} IN ('published', 'pending_review', 'rejected')`,
    ),
    check(
      "funding_rounds_stage_check",
      sql`${t.stage} IN ('pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d_plus', 'growth', 'grant', 'debt', 'undisclosed')`,
    ),
  ],
);
