CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question` text NOT NULL,
	`scope_type` text DEFAULT 'global' NOT NULL,
	`event_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`unverified` text,
	`citations` text,
	`refusal` integer DEFAULT 0 NOT NULL,
	`supplemental_fetched` text,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "questions_scope_type_check" CHECK("questions"."scope_type" IN ('event', 'global')),
	CONSTRAINT "questions_status_check" CHECK("questions"."status" IN ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "questions_refusal_check" CHECK("questions"."refusal" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `questions_status_idx` ON `questions` (`status`);--> statement-breakpoint
CREATE INDEX `questions_created_at_idx` ON `questions` (`created_at`);--> statement-breakpoint
CREATE INDEX `questions_event_id_idx` ON `questions` (`event_id`);