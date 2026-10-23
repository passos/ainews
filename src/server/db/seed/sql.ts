// The seed as SQL for `wrangler d1 execute --file` and D1 `exec`: exactly one
// statement per line (D1 `exec` splits on newlines), `'` doubled. Both inserts
// use DO NOTHING, so a repeated seed keeps what the admin changed and does
// not bring back a seed source that the admin deleted.
import { SEED_INDUSTRIES } from "./industries";
import { SEED_SOURCES } from "./sources";

const q = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const nullable = (value: string | null): string =>
  value === null ? "NULL" : q(value);

/** `now`: epoch milliseconds, used for created_at and next_fetch_at. */
export function buildSeedSql(now: number = Date.now()): string {
  const lines: string[] = [];
  for (const i of SEED_INDUSTRIES) {
    lines.push(
      `INSERT INTO industries (slug, name, publish_mode, disclaimer, primary_domains, config, created_at) VALUES (${q(i.slug)}, ${q(i.name)}, ${q(i.publishMode)}, ${nullable(i.disclaimer)}, ${q(JSON.stringify(i.primaryDomains))}, ${q(JSON.stringify({ analysis: i.analysis }))}, ${now}) ON CONFLICT(slug) DO NOTHING;`,
    );
  }
  for (const s of SEED_SOURCES) {
    lines.push(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, interval_minutes, next_fetch_at, config, jina_enabled, created_at) VALUES ((SELECT id FROM industries WHERE slug = ${q(s.industry)}), ${q(s.name)}, ${q(s.feedUrl)}, ${q(s.siteDomain)}, ${q(s.kind)}, 'active', 60, ${now}, ${q(JSON.stringify(s.config))}, 0, ${now}) ON CONFLICT(industry_id, feed_url) DO NOTHING;`,
    );
  }
  return lines.join("\n");
}
