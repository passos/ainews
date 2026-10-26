-- Due-event scheduling markers (#92).
-- artifacts_evaluated_revision: highest revision whose artifact generation
-- reached a definite outcome; the cron enqueues an event only while
-- revision > artifacts_evaluated_revision. *_scheduled_at: last cron enqueue
-- time per kind, the rotation key (0 = never; ties go by id).
-- Backfill: mark a revision as evaluated only when it already has a
-- story_brief. story_brief is the first ARTIFACT_REGISTRY type and is eligible
-- whenever the event has an approved article, so the due set after the
-- backfill is a subset of the events the old query already enqueued: no new
-- model spend. Events still waiting for a cron retry stay due.
ALTER TABLE `events` ADD `artifacts_evaluated_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `artifacts_scheduled_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `evidence_scheduled_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `watch_scheduled_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `events` SET `artifacts_evaluated_revision` = `revision`
WHERE `revision` > 0 AND EXISTS (
  SELECT 1 FROM `event_artifacts` x
  WHERE x.`event_id` = `events`.`id` AND x.`type` = 'story_brief' AND x.`input_revision` = `events`.`revision`
);
