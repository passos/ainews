CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article_id` integer NOT NULL,
	`prompt_version` text NOT NULL,
	`scores` text NOT NULL,
	`content_type` text NOT NULL,
	`evidence_tags` text NOT NULL,
	`total_score` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_article_prompt_unique` ON `analyses` (`article_id`,`prompt_version`);--> statement-breakpoint
CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`industry_id` integer NOT NULL,
	`canonical_url` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`stage` text DEFAULT 'collected' NOT NULL,
	`stage_updated_at` integer NOT NULL,
	`fetch_rung` integer,
	`body_sha` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "articles_stage_check" CHECK("articles"."stage" IN ('collected', 'body_ready', 'analyzed', 'grouped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_canonical_url_unique` ON `articles` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `articles_stage_idx` ON `articles` (`stage`,`stage_updated_at`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`day` text NOT NULL,
	`channel` text NOT NULL,
	`cap_micros` integer NOT NULL,
	`reserved_micros` integer DEFAULT 0 NOT NULL,
	`spent_micros` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `channel`)
);
--> statement-breakpoint
CREATE TABLE `corrections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`article_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_articles_article_id_unique` ON `event_articles` (`article_id`);--> statement-breakpoint
CREATE TABLE `event_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`type` text NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`input_revision` integer NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_artifacts_key_unique` ON `event_artifacts` (`event_id`,`type`,`audience`,`input_revision`,`prompt_version`,`model`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`industry_id` integer NOT NULL,
	`title` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `industries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`publish_mode` text DEFAULT 'review' NOT NULL,
	`disclaimer` text,
	`primary_domains` text DEFAULT '[]' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "industries_publish_mode_check" CHECK("industries"."publish_mode" IN ('auto', 'review'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `industries_slug_unique` ON `industries` (`slug`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`logical_key` text NOT NULL,
	`slot` text NOT NULL,
	`model` text NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
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
	CONSTRAINT "llm_calls_channel_check" CHECK("llm_calls"."channel" IN ('workers_ai', 'gateway')),
	CONSTRAINT "llm_calls_status_check" CHECK("llm_calls"."status" IN ('pending', 'in_flight', 'completed', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_calls_logical_key_unique` ON `llm_calls` (`logical_key`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article_id` integer NOT NULL,
	`body_sha` text NOT NULL,
	`decision` text NOT NULL,
	`reviewer` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_decision_check" CHECK("reviews"."decision" IN ('approved', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_article_body_unique` ON `reviews` (`article_id`,`body_sha`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`industry_id` integer NOT NULL,
	`feed_url` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`fetch_rung` integer,
	`jina_enabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sources_kind_check" CHECK("sources"."kind" IN ('rss', 'html')),
	CONSTRAINT "sources_status_check" CHECK("sources"."status" IN ('active', 'paused', 'candidate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_industry_feed_unique` ON `sources` (`industry_id`,`feed_url`);