CREATE TABLE `watch_hits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`watch_id` integer NOT NULL,
	`event_id` integer NOT NULL,
	`event_revision` integer NOT NULL,
	`hit_at` integer NOT NULL,
	`summary` text NOT NULL,
	`rationale` text NOT NULL,
	FOREIGN KEY (`watch_id`) REFERENCES `watches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `watch_hits_watch_hit_at_idx` ON `watch_hits` (`watch_id`,`hit_at`);--> statement-breakpoint
CREATE INDEX `watch_hits_event_idx` ON `watch_hits` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `watch_hits_unique` ON `watch_hits` (`watch_id`,`event_id`,`event_revision`);--> statement-breakpoint
CREATE TABLE `watches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`question` text NOT NULL,
	`criteria` text NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`industry_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`industry_id`) REFERENCES `industries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "watches_status_check" CHECK("watches"."status" IN ('active', 'paused'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watches_slug_unique` ON `watches` (`slug`);--> statement-breakpoint
CREATE INDEX `watches_industry_status_idx` ON `watches` (`industry_id`,`status`);--> statement-breakpoint
CREATE INDEX `watches_created_at_idx` ON `watches` (`created_at`);