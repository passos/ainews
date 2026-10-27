import { sql } from "drizzle-orm";
import { approvedArticleWhere, type Db, type SectionInfo } from "./articles";

export interface DigestItemView {
  eventId: number;
  eventRevision?: number;
  title: string;
  /** The text readers see: the approved model one_liner, or else the approved article summary (#114). */
  oneLiner: string;
  sourceName: string;
  articleCount: number;
}

export interface DigestView {
  id: number;
  kind?: "daily" | "weekly";
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

// Shape of one entry in digests.items_json, as written by the digest builder.
// Defined here because publication code must not import pipeline code (R1).
// Rows built before #114 have no summary and mix model text into oneLiner.
interface StoredDigestItem {
  eventId: number;
  eventRevision?: number;
  title: string;
  summary?: string;
  oneLiner?: string | null;
  sourceName: string;
  articleCount: number;
}

interface RawDigestRow {
  id: number;
  kind: "daily" | "weekly";
  section_slug: string;
  section_name: string;
  section_disclaimer: string | null;
  period_start: string;
  published_at: number | null;
  intro: string;
  items_json: string;
  copy_approved_at: number | null;
}

export interface FilteredDigestResult {
  items: DigestItemView[];
  suppressIntro: boolean;
}

// Reader-visible name for an item whose approved articles all have empty titles.
const UNTITLED_ITEM = "Untitled story";

// copyApproved: the admin approved this digest's model copy (#114). Without it,
// the stored oneLiner is never read; items show the live approved summary.
async function filterSurvivingItems(
  db: Db,
  storedItems: StoredDigestItem[],
  copyApproved: boolean,
): Promise<FilteredDigestResult> {
  if (storedItems.length === 0) return { items: [], suppressIntro: false };
  const eventIds = storedItems.map((it) => it.eventId);
  const activeEventRows = await db.all<{
    event_id: number;
    event_revision: number;
    title: string;
    summary: string | null;
  }>(sql`
    SELECT
      ea.event_id AS event_id,
      e.revision AS event_revision,
      COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title) AS title,
      COALESCE(NULLIF(a.summary_override, ''), NULLIF(an.summary_en, ''), a.summary) AS summary
    FROM event_articles ea
    JOIN events e ON e.id = ea.event_id
    JOIN articles a ON a.id = ea.article_id
    LEFT JOIN analyses an ON an.id = (
      SELECT id FROM analyses WHERE article_id = a.id AND selected = 1 ORDER BY created_at DESC, id DESC LIMIT 1
    )
    WHERE ea.event_id IN ${eventIds}
      AND ${approvedArticleWhere}
    ORDER BY COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC
  `);

  interface ActiveEventState {
    revision: number;
    firstTitle: string;
    latestSummary: string;
    count: number;
  }

  const activeEventInfo = new Map<number, ActiveEventState>();
  for (const er of activeEventRows) {
    const existing = activeEventInfo.get(er.event_id);
    if (!existing) {
      activeEventInfo.set(er.event_id, {
        revision: er.event_revision,
        firstTitle: er.title.trim() === "" ? "" : er.title,
        latestSummary: er.summary || "",
        count: 1,
      });
    } else {
      existing.count += 1;
      // The first non-empty approved title names the event.
      if (existing.firstTitle === "" && er.title.trim() !== "") {
        existing.firstTitle = er.title;
      }
      if (er.summary) {
        existing.latestSummary = er.summary;
      }
    }
  }

  for (const info of activeEventInfo.values()) {
    if (info.firstTitle === "") info.firstTitle = UNTITLED_ITEM;
  }

  const survivingItems: DigestItemView[] = [];
  let suppressIntro = false;

  for (const it of storedItems) {
    const info = activeEventInfo.get(it.eventId);
    if (!info) {
      suppressIntro = true;
      continue;
    }

    const revisionChanged =
      (it.eventRevision !== undefined && it.eventRevision !== info.revision) ||
      (it.articleCount !== undefined && info.count < it.articleCount);

    if (revisionChanged) {
      suppressIntro = true;
    }
    const useModelLine =
      copyApproved &&
      !revisionChanged &&
      typeof it.oneLiner === "string" &&
      it.oneLiner.trim() !== "";
    // Only DigestItemView fields; never spread the stored item, so neither the
    // stored summary nor an unapproved oneLiner leaks into the view.
    survivingItems.push({
      eventId: it.eventId,
      eventRevision: revisionChanged ? info.revision : it.eventRevision,
      // Only the approved article names the item (#114); the stored title may
      // belong to an article whose approval was later revoked.
      title: info.firstTitle,
      oneLiner: useModelLine
        ? (it.oneLiner as string)
        : info.latestSummary || info.firstTitle,
      sourceName: it.sourceName,
      articleCount: info.count,
    });
  }

  if (survivingItems.length < storedItems.length) {
    suppressIntro = true;
  }

  return { items: survivingItems, suppressIntro };
}

// The single gate for model copy on public pages and RSS (#114): the intro and
// one_liners show only when the admin approved them and no item changed.
async function publicDigestContent(
  db: Db,
  row: { intro: string; items_json: string; copy_approved_at: number | null },
): Promise<{ intro: string; items: DigestItemView[] }> {
  const copyApproved = row.copy_approved_at !== null;
  const stored: StoredDigestItem[] = JSON.parse(row.items_json || "[]");
  const { items, suppressIntro } = await filterSurvivingItems(
    db,
    stored,
    copyApproved,
  );
  const intro = copyApproved && !suppressIntro ? row.intro : "";
  return { intro, items };
}

export async function getDigest(
  db: Db,
  slug: string,
  dateStr: string,
  kind: "daily" | "weekly" = "daily",
): Promise<DigestView | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }

  const rows = await db.all<RawDigestRow>(sql`
    SELECT
      d.id AS id,
      d.kind AS kind,
      i.slug AS section_slug,
      i.name AS section_name,
      i.disclaimer AS section_disclaimer,
      d.period_start AS period_start,
      d.published_at AS published_at,
      d.intro AS intro,
      d.items_json AS items_json,
      d.copy_approved_at AS copy_approved_at
    FROM digests d
    JOIN industries i ON i.id = d.industry_id
    WHERE i.slug = ${slug}
      AND d.kind = ${kind}
      AND d.period_start = ${dateStr}
      AND d.status = 'ready'
      AND d.published_at IS NOT NULL
    LIMIT 1
  `);

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  // Intro is hidden unless copy is approved and no item was retracted or modified
  const { intro, items: survivingItems } = await publicDigestContent(db, row);

  if (survivingItems.length === 0) {
    return null;
  }

  return {
    id: row.id,
    kind: row.kind,
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
  kind: "daily" | "weekly" = "daily",
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
      AND d.kind = ${kind}
      AND d.status = 'ready'
      AND d.published_at IS NOT NULL
    ORDER BY d.period_start DESC
    LIMIT ${limit * 2}
  `);

  const results: RecentDigestLink[] = [];
  for (const r of rows) {
    const rawItems: StoredDigestItem[] = JSON.parse(r.items_json || "[]");
    const { items: surviving } = await filterSurvivingItems(
      db,
      rawItems,
      false,
    );
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
  kind: "daily" | "weekly";
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
      d.kind AS kind,
      i.slug AS section_slug,
      i.name AS section_name,
      i.disclaimer AS section_disclaimer,
      d.period_start AS period_start,
      d.published_at AS published_at,
      d.intro AS intro,
      d.items_json AS items_json,
      d.copy_approved_at AS copy_approved_at
    FROM digests d
    JOIN industries i ON i.id = d.industry_id
    WHERE i.slug = ${slug}
      AND d.kind IN ('daily', 'weekly')
      AND d.status = 'ready'
      AND d.published_at IS NOT NULL
    ORDER BY d.period_start DESC, d.id DESC
    LIMIT ${limit}
  `);

  const digests: DigestFeedItem[] = [];
  for (const r of rows) {
    const { intro, items: surviving } = await publicDigestContent(db, r);
    if (surviving.length > 0) {
      digests.push({
        id: r.id,
        kind: r.kind,
        periodStart: r.period_start,
        publishedAt: r.published_at!,
        intro,
        items: surviving,
      });
    }
  }

  return { section, digests };
}
