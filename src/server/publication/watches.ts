import { desc, eq, sql } from "drizzle-orm";
import { escapeXml } from "../../lib/xml";
import { safeHttpUrl } from "../../lib/url";
import { industries } from "../db/schema/industries";
import { watches } from "../db/schema/watches";
import { approvedArticleWhere, SOURCE_NAME, type Db } from "./articles";
import { SITE_NAME } from "../../lib/site";

export interface WatchHitItem {
  id: number;
  eventId: number;
  eventTitle: string;
  eventRevision: number;
  hitAt: number;
  summary: string;
  rationale: string;
  disclaimer?: string | null;
  articles: {
    id: number;
    title: string;
    summary: string | null;
    url: string | null;
    sourceName: string;
    publishedAt: number | null;
  }[];
}

export interface WatchDetailView {
  watch: {
    id: number;
    slug: string;
    question: string;
    criteria: string;
    keywords: string[];
    status: "active" | "paused";
    industryId: number | null;
    industryName: string | null;
    industrySlug: string | null;
    industryDisclaimer: string | null;
    createdAt: number;
  };
  hits: WatchHitItem[];
}

export async function getWatchView(
  db: Db,
  slug: string,
): Promise<WatchDetailView | null> {
  const watchRow = await db
    .select({
      id: watches.id,
      slug: watches.slug,
      question: watches.question,
      criteria: watches.criteria,
      keywords: watches.keywords,
      status: watches.status,
      industryId: watches.industryId,
      industryName: industries.name,
      industrySlug: industries.slug,
      industryDisclaimer: industries.disclaimer,
      createdAt: watches.createdAt,
    })
    .from(watches)
    .leftJoin(industries, eq(watches.industryId, industries.id))
    .where(eq(watches.slug, slug))
    .get();

  if (!watchRow) {
    return null;
  }

  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(watchRow.keywords);
    if (Array.isArray(parsed)) {
      keywords = parsed.filter((k): k is string => typeof k === "string");
    }
  } catch {
    keywords = watchRow.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }

  // Fetch hits ordered newest first (capped at 50 to prevent unbounded query latency)
  const hitsQuery = await db.all<{
    id: number;
    event_id: number;
    event_title: string;
    event_industry_id: number | null;
    event_industry_name: string | null;
    event_industry_disclaimer: string | null;
    event_revision: number;
    hit_at: number;
    summary: string;
    rationale: string;
  }>(sql`
    SELECT
      wh.id AS id,
      wh.event_id AS event_id,
      e.title AS event_title,
      e.industry_id AS event_industry_id,
      i.name AS event_industry_name,
      i.disclaimer AS event_industry_disclaimer,
      wh.event_revision AS event_revision,
      wh.hit_at AS hit_at,
      wh.summary AS summary,
      wh.rationale AS rationale
    FROM watch_hits wh
    JOIN events e ON e.id = wh.event_id
    LEFT JOIN industries i ON i.id = e.industry_id
    WHERE wh.watch_id = ${watchRow.id}
    ORDER BY wh.hit_at DESC
    LIMIT 50
  `);

  const hitItems: WatchHitItem[] = [];

  for (const h of hitsQuery) {
    // Only approved articles
    const articlesQuery = await db.all<{
      id: number;
      title: string;
      summary: string | null;
      canonical_url: string;
      source_name: string;
      published_at: number | null;
      fetched_at: number;
    }>(sql`
      SELECT
        a.id AS id,
        COALESCE(NULLIF(a.title_override, ''), a.title) AS title,
        COALESCE(NULLIF(a.summary_override, ''), a.summary) AS summary,
        a.canonical_url AS canonical_url,
        ${SOURCE_NAME} AS source_name,
        a.published_at AS published_at,
        a.fetched_at AS fetched_at
      FROM event_articles ea
      JOIN articles a ON a.id = ea.article_id
      JOIN sources s ON s.id = a.source_id
      WHERE ea.event_id = ${h.event_id}
        AND ${approvedArticleWhere}
      ORDER BY COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC
    `);

    // Strictly exclude hits where no approved articles remain (e.g. all were rejected or retracted)
    if (articlesQuery.length === 0) {
      continue;
    }

    const approvedIds = new Set(articlesQuery.map((a) => a.id));

    // Verify whether the supporting evidence that triggered this hit is still approved
    let evidenceArticleIds: number[] = [];
    try {
      const parsed = JSON.parse(h.rationale);
      if (Array.isArray(parsed.articleIds)) {
        evidenceArticleIds = parsed.articleIds;
      }
    } catch {
      // Ignore malformed rationale JSON
    }

    if (
      evidenceArticleIds.length > 0 &&
      !evidenceArticleIds.every((id) => approvedIds.has(id))
    ) {
      // One or more articles supporting this hit were retracted; filter out hit
      continue;
    }

    const hitDisclaimer =
      h.event_industry_disclaimer || watchRow.industryDisclaimer;

    const eventTitle =
      articlesQuery[articlesQuery.length - 1]?.title || h.event_title;

    hitItems.push({
      id: h.id,
      eventId: h.event_id,
      eventTitle,
      eventRevision: h.event_revision,
      hitAt: h.hit_at,
      summary: h.summary,
      rationale: h.rationale,
      disclaimer: hitDisclaimer,
      articles: articlesQuery.map((art) => ({
        id: art.id,
        title: art.title,
        summary: art.summary,
        url: safeHttpUrl(art.canonical_url),
        sourceName: art.source_name,
        publishedAt: art.published_at,
      })),
    });
  }

  // If the watch has no section disclaimer, but hits include section disclaimers (e.g. a Finance event in a global watch),
  // surface the Finance disclaimer (or first section disclaimer) to the watch page
  const financeHitDisclaimer = hitItems.find(
    (h) =>
      h.disclaimer &&
      (h.disclaimer.toLowerCase().includes("investment") ||
        h.disclaimer.toLowerCase().includes("education only")),
  )?.disclaimer;

  const effectiveWatchDisclaimer =
    watchRow.industryDisclaimer ||
    financeHitDisclaimer ||
    hitItems.find((h) => h.disclaimer)?.disclaimer ||
    null;

  return {
    watch: {
      id: watchRow.id,
      slug: watchRow.slug,
      question: watchRow.question,
      criteria: watchRow.criteria,
      keywords,
      status: watchRow.status,
      industryId: watchRow.industryId,
      industryName: watchRow.industryName,
      industrySlug: watchRow.industrySlug,
      industryDisclaimer: effectiveWatchDisclaimer,
      createdAt: watchRow.createdAt,
    },
    hits: hitItems,
  };
}

export async function getActiveWatchesView(
  db: Db,
): Promise<{ id: number; slug: string; question: string }[]> {
  const rows = await db
    .select({
      id: watches.id,
      slug: watches.slug,
      question: watches.question,
    })
    .from(watches)
    .where(eq(watches.status, "active"))
    .orderBy(desc(watches.createdAt))
    .all();

  return rows;
}

const x = escapeXml;

export function renderWatchFeed(
  detail: WatchDetailView,
  siteUrl: string,
): string {
  const { watch, hits } = detail;
  const base = siteUrl.replace(/\/+$/, "");
  const link = `${base}/w/${watch.slug}`;
  const description = watch.industryDisclaimer
    ? `Topic Watch: ${watch.question} — Criteria: ${watch.criteria} | ${watch.industryDisclaimer}`
    : `Topic Watch: ${watch.question} — Criteria: ${watch.criteria}`;

  const itemsXml = hits
    .map((h) => {
      const parts = [
        `What's new: ${h.summary}`,
        `Event: ${h.eventTitle}`,
        h.articles.length > 0
          ? `Sources: ${h.articles.map((a) => a.sourceName).join(", ")}`
          : null,
        h.disclaimer || watch.industryDisclaimer,
      ]
        .filter(Boolean)
        .join(" | ");

      const itemLink = `${base}/e/${h.eventId}`;

      return [
        "<item>",
        `<title>${x(h.eventTitle)} — ${x(h.summary.slice(0, 80))}</title>`,
        `<link>${x(itemLink)}</link>`,
        `<guid isPermaLink="false">${watch.id}-${h.id}</guid>`,
        `<pubDate>${new Date(h.hitAt).toUTCString()}</pubDate>`,
        `<description>${x(parts)}</description>`,
        "</item>",
      ].join("");
    })
    .join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${x(`${SITE_NAME} — Watch: ${watch.question}`)}</title>`,
    `<link>${x(link)}</link>`,
    `<description>${x(description)}</description>`,
    itemsXml,
    "</channel></rss>",
  ].join("");
}

export async function watchFeedResponse(
  db: Db,
  siteUrl: string,
  slug: string,
): Promise<Response> {
  const detail = await getWatchView(db, slug);
  if (!detail) {
    return new Response("Not found", { status: 404 });
  }

  const xml = renderWatchFeed(detail, siteUrl);
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=300",
    },
  });
}
