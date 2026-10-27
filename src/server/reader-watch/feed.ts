// Private RSS of a reader watch: /rss/p/{token}.xml (architecture §6
// "读者 watch": 令牌, 命中, 清理). Not in server/publication/: a read writes
// last_read_at. Never logs the token or the feed URL, and the feed never
// contains them.
import { sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { SITE_NAME } from "../../lib/site";
import { escapeXml } from "../../lib/xml";
import { getDb } from "../db/client";
import type { Db } from "../publication/articles";
import { loadVisibleHits, type WatchHitItem } from "../publication/watches";
import { READER_TOKEN_RE, tokenHash } from "./token";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * The cited articles (rationale.articleIds) of a hit, or null when the list
 * is missing or corrupt: the hit is then not shown. An empty list cites no
 * visible article, so citedOnly drops it too.
 */
function citedIds(rationale: string): Set<unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rationale);
  } catch {
    return null;
  }
  const ids =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { articleIds?: unknown }).articleIds
      : undefined;
  if (!Array.isArray(ids)) return null;
  return new Set(ids);
}

/** Item title when the newest cited article has an empty title. */
export const UNTITLED_ITEM = "Watch update";

/**
 * Keeps only the cited articles of each hit; drops a hit without a valid
 * list or without a visible cited article. The item title is the newest
 * cited article's own title: never the event title, which can come from an
 * article the hit does not cite.
 */
export function citedOnly(hits: WatchHitItem[]): WatchHitItem[] {
  const out: WatchHitItem[] = [];
  for (const h of hits) {
    const ids = citedIds(h.rationale);
    if (ids === null) continue;
    const articles = h.articles.filter((a) => ids.has(a.id));
    const newest = articles.at(-1);
    if (newest === undefined) continue;
    out.push({ ...h, eventTitle: newest.title || UNTITLED_ITEM, articles });
  }
  return out;
}

const x = escapeXml;

export function renderReaderFeed(
  question: string,
  hits: WatchHitItem[],
  siteUrl: string,
  watchId: number,
): string {
  const base = siteUrl.replace(/\/+$/, "");
  const itemsXml = hits
    .map((h) => {
      const description = h.articles
        .map((a) =>
          a.summary
            ? `${a.title} — ${a.summary} (${a.sourceName})`
            : `${a.title} (${a.sourceName})`,
        )
        .join(" | ");
      return [
        "<item>",
        `<title>${x(h.eventTitle)}</title>`,
        `<link>${x(`${base}/e/${h.eventId}`)}</link>`,
        `<guid isPermaLink="false">r${watchId}-${h.id}</guid>`,
        `<description>${x(description)}</description>`,
        "</item>",
      ].join("");
    })
    .join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${x(`${SITE_NAME} — Your watch: ${question}`)}</title>`,
    `<link>${x(`${base}/`)}</link>`,
    `<description>${x("Private feed. Anyone with this address can read it.")}</description>`,
    itemsXml,
    "</channel></rss>",
  ].join("");
}

export async function readerFeedResponse(
  db: Db,
  siteUrl: string,
  token: string,
  now: number,
): Promise<Response> {
  if (!READER_TOKEN_RE.test(token)) return plain(404, "Not found");
  const row = await db.get<{
    id: number;
    question: string;
    status: string;
    disabled_at: number | null;
  }>(sql`
    SELECT id, question, status, disabled_at FROM watches
    WHERE token_hash = ${await tokenHash(token)} AND owner_kind = 'reader'
  `);
  if (!row) return plain(404, "Not found");
  // Fail closed: any row that is not plainly active is gone.
  if (row.disabled_at !== null || row.status !== "active") {
    return plain(410, "Gone");
  }

  // At most one write per watch every 6 hours (architecture §6 "清理").
  await db.run(sql`
    UPDATE watches SET last_read_at = ${now}
    WHERE id = ${row.id}
      AND (last_read_at IS NULL OR last_read_at <= ${now} - 21600000)
  `);

  const hits = citedOnly(await loadVisibleHits(db, row.id, "delivered", null));
  return new Response(renderReaderFeed(row.question, hits, siteUrl, row.id), {
    status: 200,
    headers: {
      ...HEADERS,
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
}

export function serveReaderFeed(token: string): Promise<Response> {
  return readerFeedResponse(getDb(env.DB), env.SITE_URL, token, Date.now());
}
