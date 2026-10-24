// One-off backfill of the last N days of two sources (#46), run by
// scripts/backfill.ts. Entries go through the source config and storeItems
// exactly as in collectSource; the only extra rule is the time window.
// A dry run (the default) gets dryRunEnv: SELECTs reach the database, other
// statements are dropped, and any R2 or queue call throws.
import { fetchLimited, USER_AGENT } from "../../lib/http";
import { parseFeedDate } from "../../lib/time";
import { normalizeUrl } from "../../lib/url";
import { checkRobots, claimHostSlot } from "../body/robots";
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
/** Retries when another consumer holds the host's crawl slot. */
export const SLOT_RETRIES = 3;

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
  /** Time of a request (crawl slot, robots.txt cache); Date.now in the script. */
  now: () => number;
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
 * The D1 of a dry run: SELECTs run; any other statement is dropped and
 * reports one change, so claimHostSlot sees its slot as taken (its write,
 * like the robots.txt cache write of checkRobots, is lost: accepted for a
 * dry run). batch() throws: storeItems fails before it writes anything.
 */
export function readOnlyDb(db: D1Database): D1Database {
  const nothing = {
    bind: () => nothing,
    run: async () => ({ success: true, meta: { changes: 1 }, results: [] }),
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

type BackfillEnv = Pick<PipelineEnv, "DB" | "BODIES" | "Q_INGEST">;

/** An object whose every method throws. */
function refuse<T>(name: string): T {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`dry run: no ${name} call`);
      },
    },
  ) as T;
}

/**
 * The env of the whole run. A dry run gets readOnlyDb and R2 and queue
 * stand-ins that throw, so a dry run that reached storeItems would fail,
 * not write.
 */
function envFor(env: BackfillEnv, apply: boolean): BackfillEnv {
  if (apply) return env;
  return {
    DB: readOnlyDb(env.DB),
    BODIES: refuse<R2Bucket>("R2"),
    Q_INGEST: refuse<Queue>("queue"),
  };
}

/**
 * robots.txt check, the host's crawl slot (as the body fetches take it, so
 * the backfill and the Worker do not hit a host within its delay), then one
 * GET with USER_AGENT. Redirects are not followed: only `url` was checked.
 * `minDelaySec` is the least slot length; the result's delaySec is the one
 * used.
 */
async function getPage(
  env: Pick<PipelineEnv, "DB">,
  source: BackfillSource,
  url: string,
  minDelaySec: number,
  deps: BackfillDeps,
): Promise<{ res: Response; body: string; delaySec: number }> {
  const target = new URL(url);
  const domains = [target.hostname];
  if (source.site_domain?.trim()) domains.push(source.site_domain);
  const robots = await checkRobots(env, url, deps.now(), deps.fetch, domains);
  if (!robots.allowed) throw new Error(`${ROBOTS_DISALLOWED}: ${url}`);
  const delaySec = Math.max(minDelaySec, robots.crawlDelaySec ?? 0);
  for (let attempt = 0; ; attempt++) {
    const slot = await claimHostSlot(env, target.host, delaySec, deps.now());
    if (slot.claimed) break;
    if (attempt === SLOT_RETRIES) {
      throw new Error(
        `${target.host}: crawl slot busy after ${SLOT_RETRIES} retries`,
      );
    }
    await deps.sleep(slot.waitSec * 1000);
  }
  const { res, bytes, truncated } = await fetchLimited(
    url,
    {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    MAX_FEED_BYTES,
    deps.fetch,
  );
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("Location");
    throw new Error(`${url}: HTTP ${res.status} redirect to ${location}`);
  }
  if (truncated) throw new Error(`${url}: over ${MAX_FEED_BYTES} bytes`);
  return { res, body: new TextDecoder().decode(bytes), delaySec };
}

/** One catchup page per announcement day, ARXIV_DELAY_S or more apart. */
export async function backfillArxiv(
  realEnv: BackfillEnv,
  source: BackfillSource,
  opts: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillReport> {
  const env = envFor(realEnv, opts.apply);
  const pages: string[] = [];
  const items: FeedItem[] = [];
  let dropped = 0;
  let delaySec = ARXIV_DELAY_S;
  const days = arxivDays(opts.now, opts.days);
  for (const [i, day] of days.entries()) {
    if (i > 0) await deps.sleep(delaySec * 1000);
    const url = `${ARXIV_CATCHUP}${day}?abs=True`;
    const page = await getPage(env, source, url, ARXIV_DELAY_S, deps);
    delaySec = page.delaySec;
    if (page.res.status === 404) {
      pages.push(`${day}: HTTP 404, no announcement`);
      continue;
    }
    if (!page.res.ok) throw new Error(`${url}: HTTP ${page.res.status}`);
    const parsed = parseArxivCatchup(page.body, url);
    if (parsed.incomplete) {
      throw new Error(`${url} does not show all entries`);
    }
    // A 200 page without the date is not arXiv's day page (an error or a
    // check page): stop, do not count it as a day without announcement.
    if (!parsed.date) throw new Error(`${url}: no date in the page`);
    const pageDay = parseFeedDate(parsed.date, "+00:00");
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
  realEnv: BackfillEnv,
  source: BackfillSource,
  opts: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillReport> {
  const env = envFor(realEnv, opts.apply);
  const cutoff = opts.now - opts.days * DAY_MS;
  const pages: string[] = [];
  const items: FeedItem[] = [];
  let delaySec = FEED_PAGE_DELAY_S;
  for (let n = 1; n <= MAX_FEED_PAGES; n++) {
    if (n > 1) await deps.sleep(delaySec * 1000);
    const url = new URL(source.feed_url);
    if (n > 1) url.searchParams.set("paged", String(n));
    const page = await getPage(env, source, url.href, FEED_PAGE_DELAY_S, deps);
    delaySec = page.delaySec;
    if (n > 1 && page.res.status === 404) {
      pages.push(`${url.href}: HTTP 404, stop`);
      break;
    }
    if (!page.res.ok) throw new Error(`${url.href}: HTTP ${page.res.status}`);
    const found = parseFeed(page.body, url.href);
    pages.push(`${url.href}: ${found.length} items`);
    items.push(...found);
    // Entries without a date do not decide; a page with none is empty.
    const dates = found.flatMap((i) => {
      const at = parseFeedDate(i.publishedRaw, source.utc_offset)?.getTime();
      return at === undefined ? [] : [at];
    });
    if (dates.length === 0 || Math.min(...dates) < cutoff) break;
  }
  return backfillItems(env, source, items, opts, pages, 0);
}

async function backfillItems(
  env: BackfillEnv,
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
