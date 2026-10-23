-- Hand edits after drizzle-kit generate (#5):
-- 1. `PRAGMA foreign_keys=OFF` -> `PRAGMA defer_foreign_keys = true`, and the
--    matching `PRAGMA foreign_keys=ON` removed. D1 always enforces foreign
--    keys and ignores foreign_keys=OFF; deferring the check to the end of the
--    transaction lets analyses, reviews, event_articles and article_sightings
--    keep pointing at articles (and articles at sources) while both tables
--    are rebuilt.
-- 2. The two INSERT ... SELECT copy only the columns the old tables have.
--    drizzle-kit listed the new columns too, which do not exist in the old
--    tables; they take their defaults.
-- Precondition: `articles` is empty. SQLite counts the child rows orphaned by
-- DROP TABLE and the RENAME does not uncount them, so with any article row
-- the deferred check fails at commit and the whole migration rolls back
-- (checked locally with wrangler d1 execute --local; with sources but no
-- articles it applies).
CREATE TABLE `article_sightings` (
	`article_id` integer NOT NULL,
	`source_id` integer NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`article_id`, `source_id`),
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `article_sightings_source_seen_idx` ON `article_sightings` (`source_id`,`seen_at`);--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`industry_id` integer NOT NULL,
	`canonical_url` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`published_raw` text,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`stage` text DEFAULT 'collected' NOT NULL,
	`stage_updated_at` integer NOT NULL,
	`fetch_rung` integer,
	`body_sha` text,
	`requeue_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "articles_stage_check" CHECK("__new_articles"."stage" IN ('collected', 'body_ready', 'analyzed', 'grouped', 'dropped'))
);
--> statement-breakpoint
INSERT INTO `__new_articles`("id", "source_id", "industry_id", "canonical_url", "url", "title", "published_at", "fetched_at", "stage", "stage_updated_at", "fetch_rung", "body_sha") SELECT "id", "source_id", "industry_id", "canonical_url", "url", "title", "published_at", "fetched_at", "stage", "stage_updated_at", "fetch_rung", "body_sha" FROM `articles`;--> statement-breakpoint
DROP TABLE `articles`;--> statement-breakpoint
ALTER TABLE `__new_articles` RENAME TO `articles`;--> statement-breakpoint
CREATE UNIQUE INDEX `articles_canonical_url_unique` ON `articles` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `articles_stage_idx` ON `articles` (`stage`,`stage_updated_at`);--> statement-breakpoint
CREATE TABLE `__new_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`industry_id` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`feed_url` text NOT NULL,
	`site_domain` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`paused_reason` text,
	`interval_minutes` integer DEFAULT 60 NOT NULL,
	`next_fetch_at` integer DEFAULT 0 NOT NULL,
	`utc_offset` text DEFAULT '+00:00' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`etag` text,
	`last_modified` text,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`empty_fetches` integer DEFAULT 0 NOT NULL,
	`last_ok_at` integer,
	`last_failed_at` integer,
	`last_error` text,
	`fetch_rung` integer,
	`jina_enabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sources_kind_check" CHECK("__new_sources"."kind" IN ('rss', 'html')),
	CONSTRAINT "sources_status_check" CHECK("__new_sources"."status" IN ('active', 'paused', 'candidate')),
	CONSTRAINT "sources_paused_reason_check" CHECK("__new_sources"."paused_reason" IN ('failing', 'stale'))
);
--> statement-breakpoint
INSERT INTO `__new_sources`("id", "industry_id", "feed_url", "kind", "status", "fetch_rung", "jina_enabled", "created_at") SELECT "id", "industry_id", "feed_url", "kind", "status", "fetch_rung", "jina_enabled", "created_at" FROM `sources`;--> statement-breakpoint
DROP TABLE `sources`;--> statement-breakpoint
ALTER TABLE `__new_sources` RENAME TO `sources`;--> statement-breakpoint
CREATE UNIQUE INDEX `sources_industry_feed_unique` ON `sources` (`industry_id`,`feed_url`);