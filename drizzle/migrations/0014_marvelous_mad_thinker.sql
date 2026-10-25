CREATE TABLE `claim_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`claim_id` integer NOT NULL,
	`article_id` integer NOT NULL,
	`body_sha` text NOT NULL,
	`quote` text NOT NULL,
	`quote_clean` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`stance` text NOT NULL,
	`is_primary_source` integer DEFAULT 0 NOT NULL,
	`verified` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claim_evidence_stance_check" CHECK("claim_evidence"."stance" IN ('support', 'dispute')),
	CONSTRAINT "claim_evidence_is_primary_source_check" CHECK("claim_evidence"."is_primary_source" IN (0, 1)),
	CONSTRAINT "claim_evidence_verified_check" CHECK("claim_evidence"."verified" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `claim_evidence_claim_id_idx` ON `claim_evidence` (`claim_id`);--> statement-breakpoint
CREATE INDEX `claim_evidence_article_body_idx` ON `claim_evidence` (`article_id`,`body_sha`);--> statement-breakpoint
CREATE INDEX `claim_evidence_claim_verified_idx` ON `claim_evidence` (`claim_id`,`verified`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`claim_text` text NOT NULL,
	`claim_type` text NOT NULL,
	`consensus_status` text NOT NULL,
	`primary_source_preferred` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`input_revision` integer NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claims_claim_type_check" CHECK("claims"."claim_type" IN ('fact', 'interpretation', 'prediction')),
	CONSTRAINT "claims_consensus_status_check" CHECK("claims"."consensus_status" IN ('verified', 'disputed', 'unverified')),
	CONSTRAINT "claims_status_check" CHECK("claims"."status" IN ('published', 'pending_review', 'rejected')),
	CONSTRAINT "claims_primary_source_preferred_check" CHECK("claims"."primary_source_preferred" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `claims_event_revision_idx` ON `claims` (`event_id`,`input_revision`);--> statement-breakpoint
CREATE INDEX `claims_event_status_idx` ON `claims` (`event_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `claims_event_revision_key_unique` ON `claims` (`event_id`,`input_revision`,`claim_text`,`prompt_version`,`model`);