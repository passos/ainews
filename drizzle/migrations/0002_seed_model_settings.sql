-- Seed model slots, prices and budget caps (#3).
-- Keep in sync with src/providers/defaults.ts; tests/db.test.ts compares them.
-- Prices: integer micro-USD per 1M tokens (USD per 1M x 1,000,000), read from
-- the model pages on 2026-10-22. Caps: micro-USD per day; 0 rejects every call.
INSERT OR IGNORE INTO `settings` (`key`, `value`, `updated_at`) VALUES
	('models.slots', '{"judge":{"model":"typesafe/jev","channel":"gateway"},"embed":{"model":"@cf/baai/bge-m3","channel":"workers_ai"},"write":{"model":"google/gemini-3.8-flash","channel":"gateway"},"reason":{"model":"anthropic/claude-sonnet-5.5","channel":"gateway"}}', 1792627200000),
	('models.prices', '{"typesafe/jev":{"in":42000,"out":0},"@cf/baai/bge-m3":{"in":11800,"out":0},"google/gemini-3.8-flash":{"in":750000,"out":3750000},"anthropic/claude-sonnet-5.5":{"in":2000000,"out":10000000}}', 1792627200000),
	('budget.caps', '{"workers_ai":100000,"gateway":1900000,"jina":0}', 1792627200000);
