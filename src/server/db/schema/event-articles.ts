import { index, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { articles } from "./articles";
import { events } from "./events";

export const eventArticles = sqliteTable(
  "event_articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    /** An article belongs to at most one event. */
    articleId: integer("article_id")
      .notNull()
      .unique()
      .references(() => articles.id),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("event_articles_event_id_idx").on(t.eventId)],
);
