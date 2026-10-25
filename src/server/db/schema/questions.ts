import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { events } from "./events";

export const questions = sqliteTable(
  "questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    question: text("question").notNull(),
    scopeType: text("scope_type", { enum: ["event", "global"] })
      .notNull()
      .default("global"),
    eventId: integer("event_id").references(() => events.id),
    status: text("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    answer: text("answer"),
    unverified: text("unverified"),
    citations: text("citations"),
    refusal: integer("refusal").notNull().default(0),
    supplementalFetched: text("supplemental_fetched"),
    costMicros: integer("cost_micros").notNull().default(0),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("questions_status_idx").on(t.status),
    index("questions_created_at_idx").on(t.createdAt),
    index("questions_event_id_idx").on(t.eventId),
    check(
      "questions_scope_type_check",
      sql`${t.scopeType} IN ('event', 'global')`,
    ),
    check(
      "questions_status_check",
      sql`${t.status} IN ('pending', 'processing', 'completed', 'failed')`,
    ),
    check("questions_refusal_check", sql`${t.refusal} IN (0, 1)`),
  ],
);
