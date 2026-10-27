CREATE TABLE `reader_watch_admissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`logical_key` text NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reader_watch_admissions_day_idx` ON `reader_watch_admissions` (`day`);--> statement-breakpoint
ALTER TABLE `watches` ADD `owner_kind` text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE `watches` ADD `token_hash` text;--> statement-breakpoint
ALTER TABLE `watches` ADD `creator_hash` text;--> statement-breakpoint
ALTER TABLE `watches` ADD `last_read_at` integer;--> statement-breakpoint
ALTER TABLE `watches` ADD `disabled_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `watches_token_hash_unique` ON `watches` (`token_hash`);--> statement-breakpoint
CREATE INDEX `watches_owner_status_idx` ON `watches` (`owner_kind`,`status`);--> statement-breakpoint
CREATE INDEX `watches_creator_hash_idx` ON `watches` (`creator_hash`);