// RSS 2.0 for a section. Plain functions: the route calls `serveFeed`
// (rss.ts), tests call `feedResponse` with their own db.
import { escapeXml } from "../../lib/xml";
import { getSectionFeed } from "./articles";
import type { ArticleView, Db, SectionFeed } from "./articles";

const x = escapeXml;

function item(a: ArticleView, disclaimer: string | null): string {
  const parts = [a.summary, `Source: ${a.sourceName}`, disclaimer]
    .filter(Boolean)
    .join(" ");
  const date = a.publishedAt ?? a.fetchedAt;
  return [
    "<item>",
    `<title>${x(a.title)}</title>`,
    `<link>${x(a.url)}</link>`,
    `<guid isPermaLink="false">${a.id}</guid>`,
    `<pubDate>${new Date(date).toUTCString()}</pubDate>`,
    `<description>${x(parts)}</description>`,
    "</item>",
  ].join("");
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
