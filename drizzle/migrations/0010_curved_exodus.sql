CREATE TABLE `dlq_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text,
	`body_json` text NOT NULL,
	`attempts` integer NOT NULL,
	`received_at` integer NOT NULL,
	`replayed_at` integer
);
--> statement-breakpoint
CREATE INDEX `corrections_target_idx` ON `corrections` (`target_type`,`target_id`,created_at DESC,id DESC);