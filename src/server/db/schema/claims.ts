import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { articles } from "./articles";
import { events } from "./events";

export const claims = sqliteTable(
  "claims",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    claimText: text("claim_text").notNull(),
    claimType: text("claim_type", {
      enum: ["fact", "interpretation", "prediction"],
    }).notNull(),
    consensusStatus: text("consensus_status", {
      enum: ["verified", "disputed", "unverified"],
    }).notNull(),
    primarySourcePreferred: integer("primary_source_preferred")
      .notNull()
      .default(0),
    status: text("status", {
      enum: ["published", "pending_review", "rejected"],
    })
      .notNull()
      .default("pending_review"),
    inputRevision: integer("input_revision").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("claims_event_revision_key_unique").on(
      t.eventId,
      t.inputRevision,
      t.claimText,
      t.promptVersion,
      t.model,
    ),
    index("claims_event_revision_idx").on(t.eventId, t.inputRevision),
    index("claims_event_status_idx").on(t.eventId, t.status),
    check(
      "claims_claim_type_check",
      sql`${t.claimType} IN ('fact', 'interpretation', 'prediction')`,
    ),
    check(
      "claims_consensus_status_check",
      sql`${t.consensusStatus} IN ('verified', 'disputed', 'unverified')`,
    ),
    check(
      "claims_status_check",
      sql`${t.status} IN ('published', 'pending_review', 'rejected')`,
    ),
    check(
      "claims_primary_source_preferred_check",
      sql`${t.primarySourcePreferred} IN (0, 1)`,
    ),
  ],
);

export const claimEvidence = sqliteTable(
  "claim_evidence",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    claimId: integer("claim_id")
      .notNull()
      .references(() => claims.id),
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id),
    bodySha: text("body_sha").notNull(),
    quote: text("quote").notNull(),
    quoteClean: text("quote_clean").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    stance: text("stance", {
      enum: ["support", "dispute"],
    }).notNull(),
    isPrimarySource: integer("is_primary_source").notNull().default(0),
    verified: integer("verified").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("claim_evidence_claim_id_idx").on(t.claimId),
    index("claim_evidence_article_body_idx").on(t.articleId, t.bodySha),
    index("claim_evidence_claim_verified_idx").on(t.claimId, t.verified),
    check(
      "claim_evidence_stance_check",
      sql`${t.stance} IN ('support', 'dispute')`,
    ),
    check(
      "claim_evidence_is_primary_source_check",
      sql`${t.isPrimarySource} IN (0, 1)`,
    ),
    check("claim_evidence_verified_check", sql`${t.verified} IN (0, 1)`),
  ],
);
