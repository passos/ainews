import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * robots.txt cache and crawl slot per host (#6). There is no KV binding
 * (architecture §1), so the cache is in D1. See src/pipeline/body/robots.ts.
 */
export const fetchHosts = sqliteTable("fetch_hosts", {
  /** URL.host: hostname, plus the port if it is not the default. */
  host: text("host").primaryKey(),
  /** HTTP status of the robots.txt request; 0 = network error. */
  robotsStatus: integer("robots_status").notNull(),
  /** Body of a 2xx robots.txt, else null. */
  robotsBody: text("robots_body"),
  /** Epoch milliseconds. */
  robotsFetchedAt: integer("robots_fetched_at").notNull(),
  /** Crawl-delay for our group, in seconds; null = none. */
  crawlDelayS: integer("crawl_delay_s"),
  /** Epoch milliseconds: the next request to this host may start then. */
  nextAllowedAt: integer("next_allowed_at"),
});
