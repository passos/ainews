import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const industries = sqliteTable(
  "industries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    publishMode: text("publish_mode", { enum: ["auto", "review"] })
      .notNull()
      .default("review"),
    disclaimer: text("disclaimer"),
    /** JSON array of domains. */
    primaryDomains: text("primary_domains").notNull().default("[]"),
    /** JSON: prompts and thresholds. Bump `config_version` on every change. */
    config: text("config").notNull().default("{}"),
    configVersion: integer("config_version").notNull().default(1),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "industries_publish_mode_check",
      sql`${t.publishMode} IN ('auto', 'review')`,
    ),
  ],
);
