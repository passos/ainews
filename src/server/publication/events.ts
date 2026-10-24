import { sql } from "drizzle-orm";
import {
  approvedArticleWhere,
  CARD_COLUMNS,
  CARD_FROM,
  toViews,
  type ArticleView,
  type CardRow,
  type SectionInfo,
} from "./articles";

type Db = {
  all<T>(query: unknown): Promise<T[]>;
};

export interface EventView {
  id: number;
  title: string;
  section: SectionInfo;
  articles: ArticleView[];
  corrections: string[];
}

export interface EventSourceView {
  name: string;
  count: number;
}

export async function getEvent(
  db: Db,
  eventId: number,
): Promise<EventView | null> {
  // Query approved articles in timeline order (earliest first)
  const rows = await db.all<CardRow>(sql`
    SELECT
      ${CARD_COLUMNS}
      ${CARD_FROM}
    WHERE ea.event_id = ${eventId} AND ${approvedArticleWhere}
    ORDER BY COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC
  `);

  const articles = toViews(rows);
  if (articles.length === 0) return null;

  const first = articles[0];
  const section: SectionInfo = {
    slug: first.sectionSlug,
    name: first.sectionName,
    disclaimer: first.sectionDisclaimer,
  };

  const correctionRows = await db.all<{ body: string }>(sql`
    SELECT body FROM corrections
    WHERE target_type = 'events' AND target_id = ${eventId}
    ORDER BY created_at DESC, id DESC
  `);

  return {
    id: eventId,
    // Event public title: title of earliest approved article (refinement invariant 7)
    title: first.title,
    section,
    articles,
    corrections: correctionRows.map((c) => c.body),
  };
}

export async function getEventSources(
  db: Db,
  eventId: number,
): Promise<EventSourceView[]> {
  const rows = await db.all<{ name: string; count: number }>(sql`
    SELECT
      COALESCE(NULLIF(s.name, ''), s.site_domain, 'Unknown source') AS name,
      count(*) AS count
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    JOIN event_articles ea ON ea.article_id = a.id
    WHERE ea.event_id = ${eventId} AND ${approvedArticleWhere}
    GROUP BY name
    ORDER BY count DESC, name ASC
  `);

  return rows.map((r) => ({
    name: r.name,
    count: Number(r.count),
  }));
}
