import { sql } from "drizzle-orm";
import { approvedArticleWhere, type Db, type SectionInfo } from "./articles";

export interface DigestItemView {
  eventId: number;
  title: string;
  oneLiner: string;
  sourceName: string;
  articleCount: number;
}

export interface DigestView {
  id: number;
  section: SectionInfo;
  periodStart: string;
  publishedAt: number;
  intro: string;
  items: DigestItemView[];
}

export interface RecentDigestLink {
  date: string;
  publishedAt: number;
}

interface RawDigestRow {
  id: number;
  section_slug: string;
  section_name: string;
  section_disclaimer: string | null;
  period_start: string;
  published_at: number | null;
  intro: string;
  items_json: string;
}

async function filterSurvivingItems(
  db: Db,
  storedItems: DigestItemView[],
): Promise<DigestItemView[]> {
  if (storedItems.length === 0) return [];
  const eventIds = storedItems.map((it) => it.eventId);
  const activeEventRows = await db.all<{ event_id: number; title: string }>(sql`
    SELECT
      ea.event_id AS event_id,
      COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title) AS title
    FROM event_articles ea
    JOIN articles a ON a.id = ea.article_id
    LEFT JOIN analyses an ON an.id = (
      SELECT id FROM analyses WHERE article_id = a.id AND selected = 1 ORDER BY created_at DESC, id DESC LIMIT 1
    )
    WHERE ea.event_id IN ${eventIds}
      AND ${approvedArticleWhere}
    ORDER BY COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC
  `);

  const activeTitleByEvent = new Map<number, string>();
  for (const er of activeEventRows) {
    if (!activeTitleByEvent.has(er.event_id)) {
      activeTitleByEvent.set(er.event_id, er.title);
    }
  }

  const survivingItems: DigestItemView[] = [];
  for (const it of storedItems) {
    const publicTitle = activeTitleByEvent.get(it.eventId);
    if (publicTitle !== undefined) {
      survivingItems.push({
        ...it,
        title: publicTitle || it.title,
      });
    }
  }
  return survivingItems;
}

export async function getDigest(
  db: Db,
  slug: string,
  dateStr: string,
): Promise<DigestView | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }

  const rows = await db.all<RawDigestRow>(sql`
    SELECT
      d.id AS id,
      i.slug AS section_slug,
      i.name AS section_name,
      i.disclaimer AS section_disclaimer,
      d.period_start AS period_start,
      d.published_at AS published_at,
      d.intro AS intro,
      d.items_json AS items_json
    FROM digests d
    JOIN industries i ON i.id = d.industry_id
    WHERE i.slug = ${slug}
      AND d.kind = 'daily'
      AND d.period_start = ${dateStr}
      AND d.status = 'ready'
      AND d.published_at IS NOT NULL
    LIMIT 1
  `);

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  const storedItems: DigestItemView[] = JSON.parse(row.items_json || "[]");
  const survivingItems = await filterSurvivingItems(db, storedItems);

  if (survivingItems.length === 0) {
    return null;
  }

  // If any item was retracted, suppress the pre-generated intro so retracted claims are not publicized
  const intro = survivingItems.length < storedItems.length ? "" : row.intro;

  return {
    id: row.id,
    section: {
      slug: row.section_slug,
      name: row.section_name,
      disclaimer: row.section_disclaimer,
    },
    periodStart: row.period_start,
    publishedAt: row.published_at!,
    intro,
    items: survivingItems,
  };
}

export async function getRecentDigests(
  db: Db,
  slug: string,
  limit = 7,
): Promise<RecentDigestLink[]> {
  const rows = await db.all<{
    date: string;
    published_at: number;
    items_json: string;
  }>(sql`
    SELECT
      d.period_start AS date,
      d.published_at AS published_at,
      d.items_json AS items_json
    FROM digests d
    JOIN industries i ON i.id = d.industry_id
    WHERE i.slug = ${slug}
      AND d.kind = 'daily'
      AND d.status = 'ready'
      AND d.published_at IS NOT NULL
    ORDER BY d.period_start DESC
    LIMIT ${limit * 2}
  `);

  const results: RecentDigestLink[] = [];
  for (const r of rows) {
    const rawItems: DigestItemView[] = JSON.parse(r.items_json || "[]");
    const surviving = await filterSurvivingItems(db, rawItems);
    if (surviving.length > 0) {
      results.push({
        date: r.date,
        publishedAt: r.published_at,
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}

export interface DigestFeedItem {
  id: number;
  periodStart: string;
  publishedAt: number;
  intro: string;
  items: DigestItemView[];
}

export interface DigestFeed {
  section: SectionInfo;
  digests: DigestFeedItem[];
}

export async function getDigestFeed(
  db: Db,
  slug: string,
  limit = 30,
): Promise<DigestFeed | null> {
  const indRows = await db.all<{
    slug: string;
    name: string;
    disclaimer: string | null;
  }>(sql`
    SELECT slug, name, disclaimer FROM industries WHERE slug = ${slug} LIMIT 1
  `);
  if (indRows.length === 0) return null;
  const section: SectionInfo = indRows[0];

  const rows = await db.all<RawDigestRow>(sql`
    SELECT
      d.id AS id,
      i.slug AS section_slug,
      i.name AS section_name,
      i.disclaimer AS section_disclaimer,
      d.period_start AS period_start,
      d.published_at AS published_at,
      d.intro AS intro,
      d.items_json AS items_json
    FROM digests d
    JOIN industries i ON i.id = d.industry_id
    WHERE i.slug = ${slug}
      AND d.kind = 'daily'
      AND d.status = 'ready'
      AND d.published_at IS NOT NULL
    ORDER BY d.period_start DESC
    LIMIT ${limit}
  `);

  const digests: DigestFeedItem[] = [];
  for (const r of rows) {
    const rawItems: DigestItemView[] = JSON.parse(r.items_json || "[]");
    const surviving = await filterSurvivingItems(db, rawItems);
    if (surviving.length > 0) {
      // Suppress intro if any item in this digest was retracted
      const intro = surviving.length < rawItems.length ? "" : r.intro;
      digests.push({
        id: r.id,
        periodStart: r.period_start,
        publishedAt: r.published_at!,
        intro,
        items: surviving,
      });
    }
  }

  return { section, digests };
}
