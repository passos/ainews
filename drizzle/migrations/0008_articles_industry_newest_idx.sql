CREATE INDEX `articles_industry_newest_idx` ON `articles` (`industry_id`,COALESCE(published_at, fetched_at) DESC,id DESC);
