ALTER TABLE `questions` ADD `origin` text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `public_token_hash` text;