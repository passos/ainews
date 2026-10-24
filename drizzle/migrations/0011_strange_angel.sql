CREATE INDEX `event_articles_event_id_idx` ON `event_articles` (`event_id`);--> statement-breakpoint
CREATE INDEX `events_industry_created_at_idx` ON `events` (`industry_id`,`created_at`);