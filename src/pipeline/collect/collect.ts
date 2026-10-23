// Handler for `collect` messages: fetch one source, store new articles.
import { isEnabled } from "../../lib/flags";
import { fetchLimited, USER_AGENT } from "../../lib/http";
import { parseFeedDate } from "../../lib/time";
import { normalizeUrl } from "../../lib/url";
import { sendIngest, type PipelineEnv } from "../messages";
import { isExcluded, parseSourceConfig } from "./config";
import { recordFailure, recordSuccess } from "./health";
import { parseHtmlList } from "./html-list";
import { parseFeed, type FeedItem } from "./rss";

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_FEED_BYTES = 5 * 1024 * 1024;
/** Items per D1 batch. */
const INSERT_CHUNK = 50;

export interface CollectDeps {
  fetch: typeof fetch;
}

export type CollectResult =
  | { status: "disabled" | "skipped" | "not_modified" }
  | { status: "ok"; items: number; excluded: number; inserted: number[] }
  | { status: "failed"; error: string };

interface SourceRow {
  id: number;
  industry_id: number;
  kind: "rss" | "html";
  feed_url: string;
  status: string;
  utc_offset: string;
  config: string;
  etag: string | null;
  last_modified: string | null;
}

/**
 * Fetches a source and stores the entries it has not seen. Never throws for
 * fetch or parse errors: they are recorded on the source, and the next due
 * time retries (a queue retry would only add DLQ entries).
 */
export async function collectSource(
  env: PipelineEnv,
  sourceId: number,
  now: number,
  deps: CollectDeps,
): Promise<CollectResult> {
  // Also checked here: messages queued before the flag was turned off.
  if (!isEnabled(env, "COLLECT_ENABLED")) return { status: "disabled" };
  const source = await env.DB.prepare(
    `SELECT id, industry_id, kind, feed_url, status, utc_offset, config, etag,
       last_modified FROM sources WHERE id = ?1`,
  )
    .bind(sourceId)
    .first<SourceRow>();
  if (!source || source.status !== "active") return { status: "skipped" };

  try {
    const headers = new Headers({ "User-Agent": USER_AGENT });
    if (source.etag) headers.set("If-None-Match", source.etag);
    if (source.last_modified) {
      headers.set("If-Modified-Since", source.last_modified);
    }
    const { res, bytes, truncated } = await fetchLimited(
      source.feed_url,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      MAX_FEED_BYTES,
      deps.fetch,
    );
    const cache = {
      etag: res.headers.get("ETag"),
      lastModified: res.headers.get("Last-Modified"),
    };
    if (res.status === 304) {
      await recordSuccess(env.DB, source.id, now, cache);
      return { status: "not_modified" };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (truncated) throw new Error(`response is over ${MAX_FEED_BYTES} bytes`);

    const config = parseSourceConfig(source.config);
    const body = new TextDecoder().decode(bytes);
    let items: FeedItem[];
    if (source.kind === "rss") {
      items = parseFeed(body, source.feed_url);
    } else if (config.list) {
      items = parseHtmlList(body, source.feed_url, config.list);
    } else {
      throw new Error("html source has no list config");
    }
    const kept = items.filter((i) => !isExcluded(i.fields, config.exclude));
    const inserted = await storeItems(env, source, kept, now);
    await recordSuccess(env.DB, source.id, now, cache);
    const result = {
      status: "ok" as const,
      items: items.length,
      excluded: items.length - kept.length,
      inserted,
    };
    console.log({
      collect: source.id,
      items: result.items,
      excluded: result.excluded,
      inserted: inserted.length,
    });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await recordFailure(env.DB, source.id, now, error);
    console.error({ collect: source.id, error });
    return { status: "failed", error };
  }
}

interface Row {
  canonical: string;
  url: string;
  title: string;
  summary: string | null;
  publishedAt: number | null;
  publishedRaw: string | null;
}

// Each chunk is one INSERT ... ON CONFLICT(canonical_url) DO NOTHING
// RETURNING (only new rows come back) plus one sightings INSERT, so a feed
// of n items costs 2 * ceil(n / 50) D1 queries. Duplicate deliveries, the
// same entry twice in a feed, and two sources with the same article all
// end in this one statement.
const INSERT_ARTICLES = `INSERT INTO articles (source_id, industry_id, canonical_url, url,
    title, summary, published_at, published_raw, fetched_at, stage,
    stage_updated_at)
  SELECT ?2, ?3, j.value ->> '$.canonical', j.value ->> '$.url',
    j.value ->> '$.title', j.value ->> '$.summary',
    j.value ->> '$.publishedAt', j.value ->> '$.publishedRaw', ?4,
    'collected', ?4
  FROM json_each(?1) AS j WHERE true
  ON CONFLICT (canonical_url) DO NOTHING
  RETURNING id, canonical_url`;

const INSERT_SIGHTINGS = `INSERT INTO article_sightings (article_id, source_id, seen_at)
  SELECT a.id, ?2, ?3 FROM json_each(?1) AS j
    JOIN articles AS a ON a.canonical_url = j.value ->> '$.canonical'
  WHERE true
  ON CONFLICT (article_id, source_id) DO NOTHING`;

/**
 * Order: rows (stage 'collected') -> R2 feed/{id}.html -> `body` messages.
 * A crash in between leaves rows in 'collected'; the backfill cron sends
 * them later. Returns the new article ids.
 */
async function storeItems(
  env: PipelineEnv,
  source: SourceRow,
  items: FeedItem[],
  now: number,
): Promise<number[]> {
  const rows: Row[] = [];
  const content = new Map<string, string>();
  for (const item of items) {
    const canonical = normalizeUrl(item.url);
    if (!canonical) continue;
    rows.push({
      canonical,
      url: item.url,
      title: item.title,
      summary: item.summary,
      publishedAt:
        parseFeedDate(item.publishedRaw, source.utc_offset)?.getTime() ?? null,
      publishedRaw: item.publishedRaw,
    });
    if (item.contentHtml && !content.has(canonical)) {
      content.set(canonical, item.contentHtml);
    }
  }

  const inserted: { id: number; canonical_url: string }[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = JSON.stringify(rows.slice(i, i + INSERT_CHUNK));
    const [articles] = await env.DB.batch<{
      id: number;
      canonical_url: string;
    }>([
      env.DB.prepare(INSERT_ARTICLES).bind(
        chunk,
        source.id,
        source.industry_id,
        now,
      ),
      env.DB.prepare(INSERT_SIGHTINGS).bind(chunk, source.id, now),
    ]);
    inserted.push(...articles.results);
  }

  const withContent: number[] = [];
  for (const { id, canonical_url } of inserted) {
    const html = content.get(canonical_url);
    if (html === undefined) continue;
    await env.BODIES.put(`feed/${id}.html`, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    withContent.push(id);
  }
  if (withContent.length > 0) {
    await env.DB.prepare(
      "UPDATE articles SET has_feed_content = 1 WHERE id IN (SELECT value FROM json_each(?1))",
    )
      .bind(JSON.stringify(withContent))
      .run();
  }

  const ids = inserted.map((r) => r.id);
  await sendIngest(
    env,
    ids.map((articleId) => ({ kind: "body", articleId })),
  );
  return ids;
}
