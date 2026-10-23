import {
  index,
  integer,
  primaryKey,
  sqliteTable,
} from "drizzle-orm/sqlite-core";
import { articles } from "./articles";
import { sources } from "./sources";

/**
 * One row per (article, source): which sources saw an article. The row is
 * written once, so `seen_at` is the first time this source saw it. Source
 * health ("new items in the last 7 / 30 days") is counted from here.
 */
export const articleSightings = sqliteTable(
  "article_sightings",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id),
    /** Epoch milliseconds. */
    seenAt: integer("seen_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.sourceId] }),
    index("article_sightings_source_seen_idx").on(t.sourceId, t.seenAt),
  ],
);
