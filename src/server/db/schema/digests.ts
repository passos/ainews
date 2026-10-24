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

export const digests = sqliteTable(
  "digests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    industryId: integer("industry_id")
      .notNull()
      .references(() => industries.id),
    kind: text("kind").notNull(),
    /** "YYYY-MM-DD" */
    periodStart: text("period_start").notNull(),
    /** IANA time zone identifier. */
    timezone: text("timezone").notNull(),
    status: text("status", { enum: ["ready", "empty"] })
      .notNull()
      .default("ready"),
    /** LLM-generated introductory synthesis, or empty string. */
    intro: text("intro").notNull().default(""),
    /** JSON array of DigestItemView: [{ eventId, title, oneLiner, sourceName, articleCount }] */
    itemsJson: text("items_json").notNull().default("[]"),
    promptVersion: text("prompt_version"),
    model: text("model"),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    /** Epoch milliseconds when published, or null if pending review. */
    publishedAt: integer("published_at"),
    /** Epoch milliseconds when sent via email, or null. */
    emailedAt: integer("emailed_at"),
  },
  (t) => [
    unique("digests_industry_kind_period_unique").on(
      t.industryId,
      t.kind,
      t.periodStart,
    ),
    check("digests_status_check", sql`${t.status} IN ('ready', 'empty')`),
    index("digests_industry_published_idx").on(t.industryId, t.publishedAt),
  ],
);
