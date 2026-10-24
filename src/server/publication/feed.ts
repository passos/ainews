// RSS 2.0 for a section. Plain functions: the route calls `serveFeed`
// (rss.ts), tests call `feedResponse` with their own db.
import { escapeXml } from "../../lib/xml";
import { getSectionFeed } from "./articles";
import type { ArticleView, Db, SectionFeed } from "./articles";
import { getDigestFeed, type DigestFeed, type DigestFeedItem } from "./digests";

const x = escapeXml;

function item(a: ArticleView, disclaimer: string | null): string {
  const parts = [a.summary, `Source: ${a.sourceName}`, disclaimer]
    .filter(Boolean)
    .join(" ");
  const date = a.publishedAt ?? a.fetchedAt;
  return [
    "<item>",
    `<title>${x(a.title)}</title>`,
    // No <link> for a non-http(s) URL: the read layer returns null.
    ...(a.url ? [`<link>${x(a.url)}</link>`] : []),
    `<guid isPermaLink="false">${a.id}</guid>`,
    `<pubDate>${new Date(date).toUTCString()}</pubDate>`,
    `<description>${x(parts)}</description>`,
    "</item>",
  ].join("");
}

function digestItem(
  d: DigestFeedItem,
  sectionSlug: string,
  sectionDisclaimer: string | null,
  base: string,
): string {
  const itemSummary = d.items
    .map((it) => `${it.title}: ${it.oneLiner}`)
    .join(" | ");
  const parts = [d.intro, itemSummary, sectionDisclaimer]
    .filter(Boolean)
    .join(" ");
  const link = `${base}/digest/${sectionSlug}/${d.periodStart}`;

  return [
    "<item>",
    `<title>${x(`Daily Digest — ${d.periodStart}`)}</title>`,
    `<link>${x(link)}</link>`,
    `<guid isPermaLink="false">${d.id}</guid>`,
    `<pubDate>${new Date(d.publishedAt).toUTCString()}</pubDate>`,
    `<description>${x(parts)}</description>`,
    "</item>",
  ].join("");
}

export function renderDigestFeed(feed: DigestFeed, siteUrl: string): string {
  const { section, digests } = feed;
  const base = siteUrl.replace(/\/+$/, "");
  const description = [
    `Daily intelligence digests for ${section.name} from Personal News.`,
    section.disclaimer,
  ]
    .filter(Boolean)
    .join(" ");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${x(`Personal News — ${section.name} Daily Digest`)}</title>`,
    `<link>${x(`${base}/s/${section.slug}`)}</link>`,
    `<description>${x(description)}</description>`,
    ...digests.map((d) =>
      digestItem(d, section.slug, section.disclaimer, base),
    ),
    "</channel></rss>",
  ].join("\n");
}

export async function digestFeedResponse(
  db: Db,
  siteUrl: string,
  slug: string,
): Promise<Response> {
  const feed = await getDigestFeed(db, slug);
  if (!feed) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(renderDigestFeed(feed, siteUrl), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}

export function renderFeed(feed: SectionFeed, siteUrl: string): string {
  const { section, articles } = feed;
  const base = siteUrl.replace(/\/+$/, "");
  const description = [
    `Approved ${section.name} stories from Personal News.`,
    section.disclaimer,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${x(`Personal News — ${section.name}`)}</title>`,
    `<link>${x(`${base}/s/${section.slug}`)}</link>`,
    `<description>${x(description)}</description>`,
    ...articles.map((a) => item(a, section.disclaimer)),
    "</channel></rss>",
  ].join("\n");
}

export async function feedResponse(
  db: Db,
  siteUrl: string,
  slug: string,
): Promise<Response> {
  const feed = await getSectionFeed(db, slug);
  if (!feed) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(renderFeed(feed, siteUrl), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}
