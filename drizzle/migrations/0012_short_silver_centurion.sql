CREATE TABLE `digests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`industry_id` integer NOT NULL,
	`kind` text NOT NULL,
	`period_start` text NOT NULL,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`intro` text DEFAULT '' NOT NULL,
	`items_json` text DEFAULT '[]' NOT NULL,
	`prompt_version` text,
	`model` text,
	`created_at` integer NOT NULL,
	`published_at` integer,
	`emailed_at` integer,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "digests_status_check" CHECK("digests"."status" IN ('ready', 'empty'))
);
--> statement-breakpoint
CREATE INDEX `digests_industry_published_idx` ON `digests` (`industry_id`,`published_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `digests_industry_kind_period_unique` ON `digests` (`industry_id`,`kind`,`period_start`);