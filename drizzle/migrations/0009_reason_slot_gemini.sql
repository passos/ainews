-- Move the `reason` slot from Claude Sonnet to Gemini 3.8 Flash (#53).
-- Keep in sync with src/providers/defaults.ts; tests/db.test.ts compares them.
-- Only rewrite the old seed value: a model set by hand (admin, #9) stays.
-- The Sonnet price row in `models.prices` stays; it has no effect at runtime.
UPDATE `settings` SET `value` = json_set(`value`, '$.reason.model', 'google/gemini-3.8-flash'), `updated_at` = 1792821402551 WHERE `key` = 'models.slots' AND json_extract(`value`, '$.reason.model') = 'anthropic/claude-sonnet-5.5';
