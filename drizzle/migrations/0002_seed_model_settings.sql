-- Seed model slots, prices and budget caps (#3).
-- Keep in sync with src/providers/defaults.ts; tests/db.test.ts compares them.
-- Prices: USD per 1M tokens (= micro-USD per token), read from the model
-- pages on 2026-10-22. Caps: micro-USD per day; 0 rejects every call.
INSERT OR IGNORE INTO `settings` (`key`, `value`, `updated_at`) VALUES
	('models.slots', '{"judge":{"model":"typesafe/jev","channel":"workers_ai"},"embed":{"model":"@cf/baai/bge-m3","channel":"workers_ai"},"write":{"model":"google/gemini-3.8-flash","channel":"gateway"},"reason":{"model":"anthropic/claude-sonnet-5.5","channel":"gateway"}}', 1792627200000),
	('models.prices', '{"typesafe/jev":{"in":0.042,"out":0},"@cf/baai/bge-m3":{"in":0.0118,"out":0},"google/gemini-3.8-flash":{"in":0.75,"out":3.75},"anthropic/claude-sonnet-5.5":{"in":2.0,"out":10.0}}', 1792627200000),
	('budget.caps', '{"workers_ai":500000,"gateway":1500000,"jina":0}', 1792627200000);
