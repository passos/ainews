import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { events } from "./events";
import { industries } from "./industries";

export const watches = sqliteTable(
  "watches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull().unique(),
    question: text("question").notNull(),
    criteria: text("criteria").notNull(),
    keywords: text("keywords").notNull().default("[]"),
    industryId: integer("industry_id").references(() => industries.id),
    status: text("status", { enum: ["active", "paused"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /**
     * `admin` or `reader` (#132). Only `admin` rows are public
     * (adminWatchWhere). No table CHECK: adding one would rebuild the table;
     * the writer checks the closed set.
     */
    ownerKind: text("owner_kind", { enum: ["admin", "reader"] })
      .notNull()
      .default("admin"),
    /** sha256hex of a reader watch token; NULL for admin watches. */
    tokenHash: text("token_hash"),
    /** Salted hash of the creator's network address (reader watches). */
    creatorHash: text("creator_hash"),
    /** Last read of the private RSS feed. */
    lastReadAt: integer("last_read_at"),
    /** Disabled = status 'paused' and disabled_at set; not reversible. */
    disabledAt: integer("disabled_at"),
  },
  (t) => [
    index("watches_industry_status_idx").on(t.industryId, t.status),
    index("watches_created_at_idx").on(t.createdAt),
    check("watches_status_check", sql`${t.status} IN ('active', 'paused')`),
    uniqueIndex("watches_token_hash_unique").on(t.tokenHash),
    index("watches_owner_status_idx").on(t.ownerKind, t.status),
    index("watches_creator_hash_idx").on(t.creatorHash),
  ],
);

export const watchHits = sqliteTable(
  "watch_hits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    watchId: integer("watch_id")
      .notNull()
      .references(() => watches.id),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    eventRevision: integer("event_revision").notNull(),
    hitAt: integer("hit_at").notNull(),
    summary: text("summary").notNull(),
    rationale: text("rationale").notNull(),
    /**
     * Only `published` hits reach the public site. The default keeps a hit
     * that was written without a status off the public site. `delivered` is
     * a reader watch hit (#132): private RSS only, never reviewed or public.
     * No table CHECK: adding one would rebuild the table.
     */
    status: text("status", {
      enum: ["published", "pending_review", "rejected", "delivered"],
    })
      .notNull()
      .default("pending_review"),
  },
  (t) => [
    unique("watch_hits_unique").on(t.watchId, t.eventId, t.eventRevision),
    index("watch_hits_watch_hit_at_idx").on(t.watchId, t.hitAt),
    index("watch_hits_event_idx").on(t.eventId),
    index("watch_hits_watch_status_hit_at_idx").on(
      t.watchId,
      t.status,
      t.hitAt,
    ),
    index("watch_hits_status_hit_at_idx").on(t.status, t.hitAt),
  ],
);
