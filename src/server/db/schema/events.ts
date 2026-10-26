import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { industries } from "./industries";

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    industryId: integer("industry_id")
      .notNull()
      .references(() => industries.id),
    title: text("title").notNull(),
    /** +1 whenever the set of approved articles changes (architecture §6). */
    revision: integer("revision").notNull().default(0),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    /** Epoch milliseconds. */
    updatedAt: integer("updated_at").notNull(),
    /** The last revision whose watch evaluation finished (#85). */
    watchEvaluatedRevision: integer("watch_evaluated_revision")
      .notNull()
      .default(0),
    /**
     * Epoch milliseconds: the largest `effective_at` of the approved
     * articles at that evaluation. Articles after it are new reporting.
     */
    watchEvaluatedThrough: integer("watch_evaluated_through"),
    /** Highest revision whose artifact generation reached a definite outcome (#92). Only grows. */
    artifactsEvaluatedRevision: integer("artifacts_evaluated_revision")
      .notNull()
      .default(0),
    /** Epoch ms of the last cron enqueue for artifacts; rotation key (#92). 0 = never. */
    artifactsScheduledAt: integer("artifacts_scheduled_at")
      .notNull()
      .default(0),
    /** Epoch ms of the last cron enqueue for evidence; rotation key (#92). 0 = never. */
    evidenceScheduledAt: integer("evidence_scheduled_at").notNull().default(0),
    /** Epoch ms of the last cron enqueue for watch evaluation; rotation key (#92). 0 = never. */
    watchScheduledAt: integer("watch_scheduled_at").notNull().default(0),
  },
  (t) => [
    index("events_industry_created_at_idx").on(t.industryId, t.createdAt),
  ],
);
