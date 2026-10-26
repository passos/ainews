-- Due-event scheduling markers (#92).
-- artifacts_evaluated_revision: highest revision whose artifact generation
-- reached a definite outcome; the cron enqueues an event only while
-- revision > artifacts_evaluated_revision. *_scheduled_at: last cron enqueue
-- time per kind, the rotation key (0 = never; ties go by id).
-- Backfill: mark a revision as evaluated unless the old due query still
-- matched it (story_brief missing; score >= 80 and audience_explain or
-- learning_material missing; a filing and earnings_decoder missing). So the
-- due set after the backfill is a subset of the old candidate set, and events
-- still waiting for a cron retry stay due. Spend per run can exceed the old
-- query's: rotation also reaches events past the old LIMIT 20 window, and a
-- CallFailedError no longer stops the later artifact types. It stays bounded
-- by the number of due events.
ALTER TABLE `events` ADD `artifacts_evaluated_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `artifacts_scheduled_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `evidence_scheduled_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `watch_scheduled_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `events` SET `artifacts_evaluated_revision` = `revision`
WHERE `revision` > 0 AND NOT (
  NOT EXISTS (
    SELECT 1 FROM event_artifacts ea2
    WHERE ea2.event_id = `events`.`id`
      AND ea2.input_revision = `events`.`revision`
      AND ea2.type = 'story_brief'
  )
  OR (
    EXISTS (
      SELECT 1 FROM event_articles ea3
      JOIN analyses an ON an.article_id = ea3.article_id
      WHERE ea3.event_id = `events`.`id` AND an.total_score >= 80
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM event_artifacts ea4
        WHERE ea4.event_id = `events`.`id`
          AND ea4.input_revision = `events`.`revision`
          AND ea4.type = 'audience_explain'
      )
      OR NOT EXISTS (
        SELECT 1 FROM event_artifacts ea5
        WHERE ea5.event_id = `events`.`id`
          AND ea5.input_revision = `events`.`revision`
          AND ea5.type = 'learning_material'
      )
    )
  )
  OR (
    EXISTS (
      SELECT 1 FROM event_articles ea_f
      JOIN filings f ON f.article_id = ea_f.article_id
      WHERE ea_f.event_id = `events`.`id`
    )
    AND NOT EXISTS (
      SELECT 1 FROM event_artifacts ea_ed
      WHERE ea_ed.event_id = `events`.`id`
        AND ea_ed.input_revision = `events`.`revision`
        AND ea_ed.type = 'earnings_decoder'
    )
  )
);
