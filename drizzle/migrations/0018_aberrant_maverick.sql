ALTER TABLE `claim_evidence` ADD `source_role` text DEFAULT 'independent' NOT NULL;--> statement-breakpoint
ALTER TABLE `claims` ADD `reality_check` text DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE `event_articles` ADD `input_revision` integer DEFAULT 1 NOT NULL;