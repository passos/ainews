CREATE TABLE `funding_rounds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_name` text NOT NULL,
	`company_key` text NOT NULL,
	`round_name` text NOT NULL,
	`round_key` text NOT NULL,
	`amount` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`amount_micros` integer,
	`valuation` integer,
	`valuation_micros` integer,
	`sector` text NOT NULL,
	`stage` text NOT NULL,
	`investors` text DEFAULT '[]' NOT NULL,
	`lead_investors` text DEFAULT '[]' NOT NULL,
	`announced_date` text,
	`article_id` integer,
	`source_url` text NOT NULL,
	`source_articles` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`superseded_by` integer,
	`correction_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by`) REFERENCES `funding_rounds`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "funding_rounds_status_check" CHECK("funding_rounds"."status" IN ('published', 'pending_review', 'rejected')),
	CONSTRAINT "funding_rounds_stage_check" CHECK("funding_rounds"."stage" IN ('pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d_plus', 'growth', 'grant', 'debt', 'undisclosed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `funding_rounds_active_unique` ON `funding_rounds` (`company_key`,`round_key`) WHERE superseded_by IS NULL;--> statement-breakpoint
CREATE INDEX `funding_rounds_sector_idx` ON `funding_rounds` (`sector`,`status`);--> statement-breakpoint
CREATE INDEX `funding_rounds_stage_idx` ON `funding_rounds` (`stage`,`status`);--> statement-breakpoint
CREATE INDEX `funding_rounds_announced_date_idx` ON `funding_rounds` (`announced_date`,`status`);--> statement-breakpoint
CREATE INDEX `funding_rounds_superseded_idx` ON `funding_rounds` (`superseded_by`);--> statement-breakpoint
CREATE INDEX `funding_rounds_article_id_idx` ON `funding_rounds` (`article_id`);--> statement-breakpoint
CREATE INDEX `funding_rounds_status_idx` ON `funding_rounds` (`status`);