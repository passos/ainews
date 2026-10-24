import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { events } from "./events";

export const eventArtifacts = sqliteTable(
  "event_artifacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    type: text("type").notNull(),
    /** '' (not NULL) when not audience-specific: unique ignores NULLs. */
    audience: text("audience").notNull().default(""),
    /** The `events.revision` this artifact was generated from. */
    inputRevision: integer("input_revision").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    content: text("content").notNull(),
    /** Review/publication status: 'published' | 'pending_review' | 'rejected' */
    status: text("status", {
      enum: ["published", "pending_review", "rejected"],
    })
      .notNull()
      .default("pending_review"),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("event_artifacts_key_unique").on(
      t.eventId,
      t.type,
      t.audience,
      t.inputRevision,
      t.promptVersion,
      t.model,
    ),
    index("event_artifacts_event_id_status_idx").on(t.eventId, t.status),
  ],
);
