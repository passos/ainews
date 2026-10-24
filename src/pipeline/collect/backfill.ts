// One-off backfill of the last N days of two sources (#46), run by
// scripts/backfill.ts. Entries go through the source config and storeItems
// exactly as in collectSource; the only extra rule is the time window.
// A dry run (the default) only reads the database: robots.txt checks get a
// database that drops every write (readOnlyDb).
import { fetchLimited, USER_AGENT } from "../../lib/http";
import { parseFeedDate } from "../../lib/time";
import { normalizeUrl } from "../../lib/url";
import { checkRobots } from "../body/robots";
import type { PipelineEnv } from "../messages";
import { newYorkDate, newYorkOffset, parseArxivCatchup } from "./catchup";
import {
  FETCH_TIMEOUT_MS,
  MAX_FEED_BYTES,
  ROBOTS_DISALLOWED,
  storeItems,
} from "./collect";
import { isExcluded, parseSourceConfig } from "./config";
import { parseFeed, type FeedItem } from "./rss";

const DAY_MS = 24 * 60 * 60_000;
export const ARXIV_CATCHUP = "https://arxiv.org/catchup/cs.AI/";
/** arxiv.org/robots.txt asks for Crawl-delay 15; never less. */
export const ARXIV_DELAY_S = 15;
/** Least spacing between feed pages when robots.txt gives no delay. */
export const FEED_PAGE_DELAY_S = 5;
export const MAX_FEED_PAGES = 5;

export interface BackfillArgs {
  apply: boolean;
  days: number;
  /** Production bindings; the default is the local database. */
  remote: boolean;
}

const USAGE =
  "Usage: scripts/backfill.ts [--dry-run | --apply] [--days N] [--remote]";

/** Throws with the usage line on anything it does not know. */
export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = { apply: false, days: 3, remote: false };
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--days") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 14) {
        throw new Error(`--days needs a whole number from 1 to 14. ${USAGE}`);
      }
      args.days = n;
    } else throw new Error(`Unknown argument ${arg}. ${USAGE}`);
  }
  if (dryRun && args.apply) {
    throw new Error(`--dry-run and --apply together. ${USAGE}`);
  }
  return args;
}

export interface BackfillDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export interface BackfillOptions {
  apply: boolean;
  days: number;
  now: number;
}

export interface BackfillSource {
  id: number;
  industry_id: number;
  feed_url: string;
  utc_offset: string;
  config: string;
  site_domain: string | null;
}

export interface BackfillReport {
  sourceId: number;
  /** One line per page request (or skipped day). */
  pages: string[];
  /** Entries parsed from all pages. */
  fetched: number;
  /** Catchup entries without id, title or abstract. */
  dropped: number;
  /** Dropped by the source config (exclude). */
  excluded: number;
  /** Older than now - days, or without a date. */
  stale: number;
  kept: number;
  /** published_at range of the kept entries (ms). */
  oldest: number | null;
  newest: number | null;
  /** Kept articles (distinct canonical URLs) already in `articles`. */
  existing: number;
  /** Kept articles not in `articles` yet. */
  fresh: number;
  /** Up to 3 titles of fresh articles. */
  samples: string[];
  /** Rows inserted (apply only). */
  inserted: number | null;
}

export async function loadSource(
  db: D1Database,
  feedUrl: string,
): Promise<BackfillSource | null> {
  return db
    .prepare(
      `SELECT id, industry_id, feed_url, utc_offset, config, site_domain
       FROM sources WHERE feed_url = ?1 AND status = 'active'`,
    )
    .bind(feedUrl)
    .first<BackfillSource>();
}

/**
 * The D1 of a dry run: SELECTs run, every other statement does nothing,
 * batch() throws (storeItems must not run).
 */
export function readOnlyDb(db: D1Database): D1Database {
  const nothing = {
    bind: () => nothing,
    run: async () => ({ success: true, meta: { changes: 0 }, results: [] }),
    all: async () => ({ success: true, meta: { changes: 0 }, results: [] }),
    first: async () => null,
  };
  return {
    prepare: (sql: string) =>
      /^\s*SELECT\b/i.test(sql) ? db.prepare(sql) : nothing,
    batch: () => {
      throw new Error("dry run: no writes");
    },
  } as unknown as D1Database;
}

/**
 * arXiv announcement days ("YYYY-MM-DD", newest first): Monday to Friday
 * in New York whose midnight there (the RSS pubDate) is not older than
 * now - days.
 */
export function arxivDays(now: number, days: number): string[] {
  const cutoff = now - days * DAY_MS;
  const [y, m, d] = newYorkDate(now).split("-").map(Number);
  const out: string[] = [];
  for (let k = 0; k <= days; k++) {
    const noon = Date.UTC(y, m - 1, d - k, 12);
    const weekday = new Date(noon).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const ymd = new Date(noon).toISOString().slice(0, 10);
    const midnight = parseFeedDate(
      `${ymd} 00:00 ${newYorkOffset(noon)}`,
      "+00:00",
    );
    if (midnight && midnight.getTime() >= cutoff) out.push(ymd);
  }
  return out;
}

function dbFor(env: Pick<PipelineEnv, "DB">, apply: boolean) {
  return { DB: apply ? env.DB : readOnlyDb(env.DB) };
}

/** robots.txt check, then one GET with USER_AGENT. */
async function getPage(
  env: Pick<PipelineEnv, "DB">,
  source: BackfillSource,
  url: string,
  now: number,
  deps: BackfillDeps,
): Promise<{ res: Response; body: string; crawlDelaySec: number | null }> {
  const domains = [new URL(url).hostname];
  if (source.site_domain?.trim()) domains.push(source.site_domain);
  const robots = await checkRobots(env, url, now, deps.fetch, domains);
  if (!robots.allowed) throw new Error(`${ROBOTS_DISALLOWED}: ${url}`);
  const { res, bytes, truncated } = await fetchLimited(
    url,
    {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    MAX_FEED_BYTES,
    deps.fetch,
  );
  if (truncated) throw new Error(`${url}: over ${MAX_FEED_BYTES} bytes`);
  return {
    res,
    body: new TextDecoder().decode(bytes),
    crawlDelaySec: robots.crawlDelaySec,
  };
}

/** One catchup page per announcement day, ARXIV_DELAY_S or more apart. */
export async function backfillArxiv(
  env: Pick<PipelineEnv, "DB" | "BODIES" | "Q_INGEST">,
  source: BackfillSource,
  opts: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillReport> {
  const db = dbFor(env, opts.apply);
  const pages: string[] = [];
  const items: FeedItem[] = [];
  let dropped = 0;
  let delaySec = ARXIV_DELAY_S;
  const days = arxivDays(opts.now, opts.days);
  for (const [i, day] of days.entries()) {
    if (i > 0) await deps.sleep(delaySec * 1000);
    const url = `${ARXIV_CATCHUP}${day}?abs=True`;
    const page = await getPage(db, source, url, opts.now, deps);
    delaySec = Math.max(ARXIV_DELAY_S, page.crawlDelaySec ?? 0);
    if (page.res.status === 404) {
      pages.push(`${day}: HTTP 404, no announcement`);
      continue;
    }
    if (!page.res.ok) throw new Error(`${url}: HTTP ${page.res.status}`);
    const parsed = parseArxivCatchup(page.body, url);
    if (parsed.incomplete) {
      throw new Error(`${url} does not show all entries`);
    }
    const pageDay = parsed.date ? parseFeedDate(parsed.date, "+00:00") : null;
    if (pageDay?.toISOString().slice(0, 10) !== day) {
      pages.push(`${day}: no announcement (page is for ${parsed.date})`);
      continue;
    }
    pages.push(`${day}: ${parsed.items.length} entries`);
    items.push(...parsed.items);
    dropped += parsed.dropped;
  }
  return backfillItems(env, source, items, opts, pages, dropped);
}

/**
 * The feed, then ?paged=2.. until a page reaches now - days, is empty or
 * not found, or MAX_FEED_PAGES pages are read.
 */
export async function backfillFeedPages(
  env: Pick<PipelineEnv, "DB" | "BODIES" | "Q_INGEST">,
  source: BackfillSource,
  opts: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillReport> {
  const db = dbFor(env, opts.apply);
  const cutoff = opts.now - opts.days * DAY_MS;
  const pages: string[] = [];
  const items: FeedItem[] = [];
  let delaySec = FEED_PAGE_DELAY_S;
  for (let n = 1; n <= MAX_FEED_PAGES; n++) {
    if (n > 1) await deps.sleep(delaySec * 1000);
    const url = new URL(source.feed_url);
    if (n > 1) url.searchParams.set("paged", String(n));
    const page = await getPage(db, source, url.href, opts.now, deps);
    delaySec = Math.max(FEED_PAGE_DELAY_S, page.crawlDelaySec ?? 0);
    if (n > 1 && page.res.status === 404) {
      pages.push(`${url.href}: HTTP 404, stop`);
      break;
    }
    if (!page.res.ok) throw new Error(`${url.href}: HTTP ${page.res.status}`);
    const found = parseFeed(page.body, url.href);
    pages.push(`${url.href}: ${found.length} items`);
    items.push(...found);
    const dates = found.map(
      (i) => parseFeedDate(i.publishedRaw, source.utc_offset)?.getTime() ?? 0,
    );
    if (found.length === 0 || Math.min(...dates) < cutoff) break;
  }
  return backfillItems(env, source, items, opts, pages, 0);
}

async function backfillItems(
  env: Pick<PipelineEnv, "DB" | "BODIES" | "Q_INGEST">,
  source: BackfillSource,
  items: FeedItem[],
  opts: BackfillOptions,
  pages: string[],
  dropped: number,
): Promise<BackfillReport> {
  const cutoff = opts.now - opts.days * DAY_MS;
  const config = parseSourceConfig(source.config);
  const notExcluded = items.filter(
    (i) => !isExcluded(i.fields, config.exclude),
  );
  const kept: FeedItem[] = [];
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const item of notExcluded) {
    const at = parseFeedDate(item.publishedRaw, source.utc_offset)?.getTime();
    if (at === undefined || at < cutoff) continue;
    kept.push(item);
    oldest = Math.min(oldest ?? at, at);
    newest = Math.max(newest ?? at, at);
  }

  const byCanonical = new Map<string, FeedItem>();
  for (const item of kept) {
    const canonical = normalizeUrl(item.url);
    if (canonical && !byCanonical.has(canonical)) {
      byCanonical.set(canonical, item);
    }
  }
  const { results } = await env.DB.prepare(
    `SELECT canonical_url FROM articles
     WHERE canonical_url IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify([...byCanonical.keys()]))
    .all<{ canonical_url: string }>();
  const existing = new Set(results.map((r) => r.canonical_url));
  const fresh = [...byCanonical].filter(([c]) => !existing.has(c));

  let inserted: number | null = null;
  if (opts.apply) {
    inserted = (await storeItems(env, source, kept, opts.now)).inserted.length;
  }
  return {
    sourceId: source.id,
    pages,
    fetched: items.length,
    dropped,
    excluded: items.length - notExcluded.length,
    stale: notExcluded.length - kept.length,
    kept: kept.length,
    oldest,
    newest,
    existing: existing.size,
    fresh: fresh.length,
    samples: fresh.slice(0, 3).map(([, i]) => i.title),
    inserted,
  };
}
