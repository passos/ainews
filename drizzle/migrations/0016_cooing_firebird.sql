CREATE TABLE `discovery_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`industry_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`search_queries` text DEFAULT '[]' NOT NULL,
	`candidates_found` integer DEFAULT 0 NOT NULL,
	`candidates_added` integer DEFAULT 0 NOT NULL,
	`candidates_auto_enabled` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "discovery_runs_status_check" CHECK("discovery_runs"."status" IN ('pending', 'running', 'completed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `discovery_runs_industry_idx` ON `discovery_runs` (`industry_id`);--> statement-breakpoint
CREATE INDEX `discovery_runs_status_idx` ON `discovery_runs` (`status`);--> statement-breakpoint
CREATE INDEX `discovery_runs_created_at_idx` ON `discovery_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `source_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer,
	`industry_id` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`feed_url` text NOT NULL,
	`site_domain` text,
	`kind` text DEFAULT 'rss' NOT NULL,
	`fetch_rung` integer,
	`sample_urls` text DEFAULT '[]' NOT NULL,
	`sample_scores` text DEFAULT '[]' NOT NULL,
	`avg_score` integer,
	`requires_browser` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rejection_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `discovery_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "source_candidates_kind_check" CHECK("source_candidates"."kind" IN ('rss', 'html')),
	CONSTRAINT "source_candidates_status_check" CHECK("source_candidates"."status" IN ('pending', 'approved', 'rejected', 'auto_enabled')),
	CONSTRAINT "source_candidates_requires_browser_check" CHECK("source_candidates"."requires_browser" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `source_candidates_industry_idx` ON `source_candidates` (`industry_id`);--> statement-breakpoint
CREATE INDEX `source_candidates_status_idx` ON `source_candidates` (`status`);--> statement-breakpoint
CREATE INDEX `source_candidates_run_id_idx` ON `source_candidates` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_candidates_industry_feed_unique` ON `source_candidates` (`industry_id`,`feed_url`);