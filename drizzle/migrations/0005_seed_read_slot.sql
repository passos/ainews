-- Seed the `read` slot (Jina Reader, fetch ladder rung 3) and its price (#6).
-- Keep in sync with src/providers/defaults.ts; tests/db.test.ts compares them.
-- 0002 is already applied in production, so the keys are added here with
-- json_set; the other slots and prices stay as they are. Price: assumption,
-- $0.05 per 1M tokens as integer micro-USD, counted as output tokens.
UPDATE `settings` SET `value` = json_set(`value`, '$.read', json('{"model":"jina/reader","channel":"jina"}')), `updated_at` = 1792713600000 WHERE `key` = 'models.slots';--> statement-breakpoint
UPDATE `settings` SET `value` = json_set(`value`, '$."jina/reader"', json('{"in":0,"out":50000}')), `updated_at` = 1792713600000 WHERE `key` = 'models.prices';
