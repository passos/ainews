-- Watch hit review and the per-event watch evaluation marker (#85).
-- Backfill: mark every existing event revision as already evaluated, with
-- the current updated_at as the boundary of known reporting. A watch only
-- reacts to revisions after it exists; without this, creating the first
-- watch would evaluate every historical event at once (real model spend
-- nobody approved). watch_hits is not backfilled: existing hits take the
-- default pending_review and need an explicit approval.
ALTER TABLE `events` ADD `watch_evaluated_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `watch_evaluated_through` integer;--> statement-breakpoint
ALTER TABLE `watch_hits` ADD `status` text DEFAULT 'pending_review' NOT NULL;--> statement-breakpoint
CREATE INDEX `watch_hits_watch_status_hit_at_idx` ON `watch_hits` (`watch_id`,`status`,`hit_at`);--> statement-breakpoint
CREATE INDEX `watch_hits_status_hit_at_idx` ON `watch_hits` (`status`,`hit_at`);--> statement-breakpoint
UPDATE `events` SET `watch_evaluated_revision` = `revision`, `watch_evaluated_through` = `updated_at`;
