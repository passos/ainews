-- Hand edits after drizzle-kit generate (#6), as in 0003_collect.sql:
-- 1. `PRAGMA foreign_keys=OFF` -> `PRAGMA defer_foreign_keys = true`, and the
--    matching `PRAGMA foreign_keys=ON` removed. D1 always enforces foreign
--    keys and ignores foreign_keys=OFF; deferring the check to the end of the
--    transaction lets analyses, reviews, event_articles and article_sightings
--    keep pointing at articles while it is rebuilt. No table references
--    llm_calls.
-- 2. The articles INSERT ... SELECT copies only the columns the old table
--    has. drizzle-kit listed body_kind, body_truncated and body_fetched_at
--    too, which do not exist in the old table; they take their defaults.
-- llm_calls is rebuilt to add 'jina' to its channel CHECK (Jina Reader is the
-- `read` slot of the model client); its copy lists only existing columns.
-- Precondition (same as 0003): `articles` is empty. With any article row the
-- deferred foreign key check fails at commit and the migration rolls back.
CREATE TABLE `fetch_hosts` (
	`host` text PRIMARY KEY NOT NULL,
	`robots_status` integer NOT NULL,
	`robots_body` text,
	`robots_fetched_at` integer NOT NULL,
	`crawl_delay_s` integer,
	`next_allowed_at` integer
);
--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_llm_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`logical_key` text NOT NULL,
	`slot` text NOT NULL,
	`model` text NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`sent_at` integer,
	`request_json` text,
	`response_json` text,
	`error` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`estimated_micros` integer,
	`cost_micros` integer,
	`budget_day` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "llm_calls_channel_check" CHECK("__new_llm_calls"."channel" IN ('workers_ai', 'gateway', 'jina')),
	CONSTRAINT "llm_calls_status_check" CHECK("__new_llm_calls"."status" IN ('pending', 'in_flight', 'completed', 'failed', 'unknown'))
);
--> statement-breakpoint
INSERT INTO `__new_llm_calls`("id", "logical_key", "slot", "model", "channel", "status", "attempt", "failures", "lease_expires_at", "sent_at", "request_json", "response_json", "error", "input_tokens", "output_tokens", "estimated_micros", "cost_micros", "budget_day", "created_at", "updated_at") SELECT "id", "logical_key", "slot", "model", "channel", "status", "attempt", "failures", "lease_expires_at", "sent_at", "request_json", "response_json", "error", "input_tokens", "output_tokens", "estimated_micros", "cost_micros", "budget_day", "created_at", "updated_at" FROM `llm_calls`;--> statement-breakpoint
DROP TABLE `llm_calls`;--> statement-breakpoint
ALTER TABLE `__new_llm_calls` RENAME TO `llm_calls`;--> statement-breakpoint
CREATE UNIQUE INDEX `llm_calls_logical_key_unique` ON `llm_calls` (`logical_key`);--> statement-breakpoint
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
	`body_kind` text,
	`body_truncated` integer DEFAULT 0 NOT NULL,
	`body_fetched_at` integer,
	`requeue_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "articles_stage_check" CHECK("__new_articles"."stage" IN ('collected', 'body_ready', 'analyzed', 'grouped', 'dropped')),
	CONSTRAINT "articles_body_kind_check" CHECK("__new_articles"."body_kind" IN ('full', 'summary'))
);
--> statement-breakpoint
INSERT INTO `__new_articles`("id", "source_id", "industry_id", "canonical_url", "url", "title", "summary", "published_raw", "published_at", "fetched_at", "stage", "stage_updated_at", "fetch_rung", "body_sha", "requeue_count") SELECT "id", "source_id", "industry_id", "canonical_url", "url", "title", "summary", "published_raw", "published_at", "fetched_at", "stage", "stage_updated_at", "fetch_rung", "body_sha", "requeue_count" FROM `articles`;--> statement-breakpoint
DROP TABLE `articles`;--> statement-breakpoint
ALTER TABLE `__new_articles` RENAME TO `articles`;--> statement-breakpoint
CREATE UNIQUE INDEX `articles_canonical_url_unique` ON `articles` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `articles_stage_idx` ON `articles` (`stage`,`stage_updated_at`);--> statement-breakpoint
ALTER TABLE `sources` ADD `rung_fail_count` integer DEFAULT 0 NOT NULL;