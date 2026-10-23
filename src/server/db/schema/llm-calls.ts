import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Model call ledger (architecture §6). State machine and the conditional
 * UPDATEs that drive it live in src/providers/ledger.ts.
 */
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    logicalKey: text("logical_key").notNull().unique(),
    slot: text("slot").notNull(),
    model: text("model").notNull(),
    channel: text("channel", {
      enum: ["workers_ai", "gateway", "jina"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "in_flight", "completed", "failed", "unknown"],
    }).notNull(),
    /** Fencing token: +1 on every acquire, never decreases. */
    attempt: integer("attempt").notNull().default(0),
    /** Real failures; a budget rejection does not count. Max MAX_ATTEMPTS. */
    failures: integer("failures").notNull().default(0),
    /** Epoch milliseconds. */
    leaseExpiresAt: integer("lease_expires_at"),
    /** Epoch milliseconds; set right before the request goes out. */
    sentAt: integer("sent_at"),
    requestJson: text("request_json"),
    responseJson: text("response_json"),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Micro-USD (1 USD = 1,000,000). */
    estimatedMicros: integer("estimated_micros"),
    /** Micro-USD. */
    costMicros: integer("cost_micros"),
    /** UTC YYYY-MM-DD of the budget row the reservation was made on. */
    budgetDay: text("budget_day"),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
    /** Epoch milliseconds. */
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check(
      "llm_calls_channel_check",
      sql`${t.channel} IN ('workers_ai', 'gateway', 'jina')`,
    ),
    check(
      "llm_calls_status_check",
      sql`${t.status} IN ('pending', 'in_flight', 'completed', 'failed', 'unknown')`,
    ),
  ],
);
