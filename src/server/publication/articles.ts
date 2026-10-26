// The only public read layer for articles. Pages, RSS and later pages (#11,
// #12) read through here. Plain functions that take `db`: server functions
// (api.ts) and tests both call them.
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { attributeSource } from "../../lib/source-attribution";
import { parseContentDisplay } from "../../lib/content-display";
import {
  renderArticleExcerpt,
  renderArticleMarkdown,
} from "../../lib/markdown";
import { safeHttpUrl } from "../../lib/url";
import type { getDb } from "../db/client";

export type Db = ReturnType<typeof getDb>;

export const SECTION_PAGE_SIZE = 20;
export const FEED_SIZE = 50;
const HOME_PER_SECTION = 5;
const HOME_CORRECTIONS = 5;

/**
 * THE definition of "approved": a review of the article's current body
 * version, decided "approved". An approval of an older body, a rejection
 * (including a take-down) or no review all mean "not public". The article
 * table must be aliased `a`. Every public read uses this one fragment.
 * Pipeline code interpolates this string into D1 `prepare()` text. Do not
 * interpolate `approvedArticleWhere` into a JS template string: it is an
 * object and becomes `[object Object]`.
 */
export const APPROVED_ARTICLE_SQL = `EXISTS (
  SELECT 1 FROM reviews r
  WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
)`;

/** APPROVED_ARTICLE_SQL as a drizzle fragment, for public reads. */
export const approvedArticleWhere: SQL = sql.raw(APPROVED_ARTICLE_SQL);

// Newest first; id makes the order total, so paging neither repeats nor
// skips rows. Must stay identical to articles_industry_newest_idx (schema),
// or SQLite sorts instead of reading the index.
export const NEWEST_FIRST = sql`COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC`;

// Raw source columns for `s` (sources) and `a` (articles). Pages map them
// with `publicSource()`; the host rule lives only in lib/source-attribution.
export const SOURCE_COLUMNS = sql`
  s.name AS source_raw_name,
  s.site_domain AS source_site_domain,
  s.feed_url AS source_feed_url,
  a.canonical_url AS source_canonical_url`;

export interface SourceColumnsRow {
  source_raw_name: string;
  source_site_domain: string | null;
  source_feed_url: string;
  source_canonical_url: string;
}

/**
 * Reader-facing source name and domain. A system placeholder source shows the
 * document's host; a real source with no name falls back to its domain.
 */
export function publicSource(r: SourceColumnsRow): {
  name: string;
  domain: string;
} {
  const s = attributeSource({
    name: r.source_raw_name,
    siteDomain: r.source_site_domain,
    feedUrl: r.source_feed_url,
    canonicalUrl: r.source_canonical_url,
  });
  return {
    name: s.name || r.source_site_domain || "Unknown source",
    domain: s.domain,
  };
}

// Card text: admin override, then the newest analysis, then the feed's own.
export const CARD_COLUMNS = sql`
  a.id AS id,
  COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title) AS title,
  COALESCE(NULLIF(a.summary_override, ''), NULLIF(an.summary_en, ''), a.summary) AS summary,
  a.url AS url,
  a.published_at AS published_at,
  a.fetched_at AS fetched_at,
  ${SOURCE_COLUMNS},
  an.evidence_tags AS evidence_tags,
  i.slug AS section_slug,
  i.name AS section_name,
  i.disclaimer AS section_disclaimer,
  (SELECT body FROM corrections c WHERE c.target_type = 'articles' AND c.target_id = a.id
    ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS correction,
  ea.event_id AS event_id,
  COALESCE(ea.input_revision, 1) AS input_revision,
  (SELECT count(*) FROM event_articles ea2
   JOIN articles a2 ON a2.id = ea2.article_id
   WHERE ea2.event_id = ea.event_id
     AND EXISTS (
       SELECT 1 FROM reviews r2
       WHERE r2.article_id = a2.id AND r2.body_sha = a2.body_sha AND r2.decision = 'approved'
     )) AS event_report_count`;

export const CARD_FROM = sql`
  FROM articles a
  JOIN sources s ON s.id = a.source_id
  JOIN industries i ON i.id = a.industry_id
  LEFT JOIN event_articles ea ON ea.article_id = a.id
  LEFT JOIN analyses an ON an.id = (
    SELECT id FROM analyses WHERE article_id = a.id
    ORDER BY created_at DESC, id DESC LIMIT 1
  )`;

export interface SectionInfo {
  slug: string;
  name: string;
  disclaimer: string | null;
  latestDigestDate?: string | null;
  latestWeeklyDigestDate?: string | null;
}

export interface ArticleView {
  id: number;
  title: string;
  /** Plain text. Null when there is no summary at all. */
  summary: string | null;
  /** Original article URL; null unless it is an http(s) URL. */
  url: string | null;
  sourceName: string;
  /** Epoch milliseconds, from the source. */
  publishedAt: number | null;
  /** Epoch milliseconds. */
  fetchedAt: number;
  /** Evidence label options, for example "preprint". */
  evidence: string[];
  /** Newest public correction text, if any. */
  correction: string | null;
  sectionSlug: string;
  sectionName: string;
  sectionDisclaimer: string | null;
  eventId: number | null;
  eventReportCount: number;
  inputRevision: number;
}

export interface CardRow extends SourceColumnsRow {
  id: number;
  title: string;
  summary: string | null;
  url: string;
  published_at: number | null;
  fetched_at: number;
  evidence_tags: string | null;
  section_slug: string;
  section_name: string;
  section_disclaimer: string | null;
  correction: string | null;
  event_id: number | null;
  event_report_count: number | null;
  input_revision: number | null;
}

// Label options that say nothing: skipped on the card.
const QUIET = new Set(["uncertain", "not_applicable", "not_stated"]);

function evidenceOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return [];
    return Object.values(value).filter(
      (v): v is string => typeof v === "string" && !QUIET.has(v),
    );
  } catch {
    return [];
  }
}

// Source URLs are untrusted: only http(s) ones leave the read layer. Pages
// and RSS both read through here.
export function toViews(rows: CardRow[]): ArticleView[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    url: safeHttpUrl(r.url),
    sourceName: publicSource(r).name,
    publishedAt: r.published_at,
    fetchedAt: r.fetched_at,
    evidence: evidenceOf(r.evidence_tags),
    correction: r.correction,
    sectionSlug: r.section_slug,
    sectionName: r.section_name,
    sectionDisclaimer: r.section_disclaimer,
    eventId: r.event_id ?? null,
    eventReportCount: Number(r.event_report_count ?? 0),
    inputRevision: Number(r.input_revision ?? 1),
  }));
}

/** All sections, in `id` order (Technology, Education, Industry, Finance). */
export async function listSections(db: Db): Promise<SectionInfo[]> {
  return db.all<SectionInfo>(
    sql`SELECT slug, name, disclaimer FROM industries ORDER BY id`,
  );
}

async function findSection(db: Db, slug: string): Promise<SectionInfo | null> {
  const rows = await db.all<SectionInfo>(
    sql`SELECT i.slug, i.name, i.disclaimer,
          (SELECT d.period_start FROM digests d
           WHERE d.industry_id = i.id
             AND d.kind = 'daily'
             AND d.status = 'ready'
             AND d.published_at IS NOT NULL
           ORDER BY d.period_start DESC
           LIMIT 1) AS latestDigestDate,
          (SELECT d.period_start FROM digests d
           WHERE d.industry_id = i.id
             AND d.kind = 'weekly'
             AND d.status = 'ready'
             AND d.published_at IS NOT NULL
           ORDER BY d.period_start DESC
           LIMIT 1) AS latestWeeklyDigestDate
        FROM industries i WHERE i.slug = ${slug}`,
  );
  return rows[0] ?? null;
}

export interface SectionPage {
  section: SectionInfo;
  articles: ArticleView[];
  hasMore: boolean;
}

/** One page of approved articles; null when the section does not exist. */
export async function getSection(
  db: Db,
  { slug, page }: { slug: string; page: number },
): Promise<SectionPage | null> {
  const section = await findSection(db, slug);
  if (!section) return null;
  const offset = (Math.max(1, page) - 1) * SECTION_PAGE_SIZE;
  // One extra row tells whether there is a next page.
  const rows = await db.all<CardRow>(sql`
    SELECT ${CARD_COLUMNS} ${CARD_FROM}
    WHERE i.slug = ${slug} AND ${approvedArticleWhere}
    ORDER BY ${NEWEST_FIRST}
    LIMIT ${SECTION_PAGE_SIZE + 1} OFFSET ${offset}`);
  return {
    section,
    articles: toViews(rows.slice(0, SECTION_PAGE_SIZE)),
    hasMore: rows.length > SECTION_PAGE_SIZE,
  };
}

export interface SectionFeed {
  section: SectionInfo;
  articles: ArticleView[];
}

/** The latest approved articles for RSS; null when the section is unknown. */
export async function getSectionFeed(
  db: Db,
  slug: string,
): Promise<SectionFeed | null> {
  const section = await findSection(db, slug);
  if (!section) return null;
  const rows = await db.all<CardRow>(sql`
    SELECT ${CARD_COLUMNS} ${CARD_FROM}
    WHERE i.slug = ${slug} AND ${approvedArticleWhere}
    ORDER BY ${NEWEST_FIRST}
    LIMIT ${FEED_SIZE}`);
  return { section, articles: toViews(rows) };
}

export interface HomeSection extends SectionInfo {
  articles: ArticleView[];
}

export interface HomeWatchItem {
  slug: string;
  question: string;
}

/** The newest approved articles of every section, for the home page. */
export async function getHome(
  db: Db,
): Promise<{ sections: HomeSection[]; watches: HomeWatchItem[] }> {
  const sections: HomeSection[] = [];
  // One query per section: each reads only its newest rows from the index.
  for (const s of await listSections(db)) {
    const rows = await db.all<CardRow>(sql`
      SELECT ${CARD_COLUMNS} ${CARD_FROM}
      WHERE i.slug = ${s.slug} AND ${approvedArticleWhere}
      ORDER BY ${NEWEST_FIRST}
      LIMIT ${HOME_PER_SECTION}`);
    sections.push({ ...s, articles: toViews(rows) });
  }

  const watchRows = await db.all<HomeWatchItem>(sql`
    SELECT slug, question FROM watches WHERE status = 'active' ORDER BY created_at DESC
  `);

  return { sections, watches: watchRows };
}

export interface PublicCorrection {
  id: number;
  body: string;
  /** Epoch milliseconds. */
  createdAt: number;
  articleId: number;
  articleTitle: string;
  sectionSlug: string;
}

/** The newest public corrections: only those of approved articles. */
export async function getRecentCorrections(
  db: Db,
): Promise<PublicCorrection[]> {
  const rows = await db.all<{
    id: number;
    body: string;
    created_at: number;
    article_id: number;
    title: string;
    section_slug: string;
  }>(sql`
    SELECT c.id AS id, c.body AS body, c.created_at AS created_at,
      a.id AS article_id,
      COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title) AS title,
      i.slug AS section_slug
    FROM corrections c
    JOIN articles a ON c.target_type = 'articles' AND c.target_id = a.id
    JOIN industries i ON i.id = a.industry_id
    LEFT JOIN analyses an ON an.id = (
      SELECT id FROM analyses WHERE article_id = a.id
      ORDER BY created_at DESC, id DESC LIMIT 1
    )
    WHERE ${approvedArticleWhere}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${HOME_CORRECTIONS}`);
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: r.created_at,
    articleId: r.article_id,
    articleTitle: r.title,
    sectionSlug: r.section_slug,
  }));
}

export interface PublicSource {
  name: string;
  /** `https://<site_domain>/`, or null when the domain is unknown. */
  homepage: string | null;
}

/** Active sources of a section; system placeholder sources never show. */
export async function getSectionSources(
  db: Db,
  slug: string,
): Promise<PublicSource[]> {
  const rows = await db.all<{ name: string; site_domain: string | null }>(sql`
    SELECT s.name AS name, s.site_domain AS site_domain
    FROM sources s JOIN industries i ON i.id = s.industry_id
    WHERE i.slug = ${slug} AND s.status = 'active'
      AND s.feed_url NOT LIKE 'system:%'
    ORDER BY s.name, s.id`);
  return rows.map((r) => ({
    name: r.name,
    homepage: r.site_domain ? `https://${r.site_domain}/` : null,
  }));
}

export interface ArticlePage {
  article: ArticleView;
  /** Who wrote the summary: editor = summary_override; ai = the newest analysis; feed = the feed. */
  summaryKind: "editor" | "ai" | "feed";
  /** The approval of the current version is not "auto" (a person approved it). */
  editorApproved: boolean;
  /** Sanitised body HTML; null = show no body. */
  bodyHtml: string | null;
  /** Excerpt source: "Continue reading the original" follows the body (or summary). */
  excerpted: boolean;
  /** The source's body is the feed summary, the authors' abstract (summaryIsBody). */
  bodyIsAbstract: boolean;
}

interface ArticlePageRow extends CardRow {
  body_sha: string;
  body_kind: string | null;
  content_display: string | null;
  summary_kind: ArticlePage["summaryKind"];
  approved_by: string | null;
  body_is_abstract: number | null;
}

/**
 * The reader page of one approved article; null when it is not approved.
 * Reads D1 and R2 only: no model call, no budget. The body is the version the
 * approval is bound to (`a.body_sha` of the row that passed
 * approvedArticleWhere), cut to the source's content_display.
 */
export async function getArticlePage(
  db: Db,
  bodies: Pick<R2Bucket, "get">,
  id: number,
): Promise<ArticlePage | null> {
  // approved_by only names the approver; approvedArticleWhere alone decides
  // whether the article is public.
  const rows = await db.all<ArticlePageRow>(sql`
    SELECT ${CARD_COLUMNS},
      a.body_sha AS body_sha,
      a.body_kind AS body_kind,
      s.content_display AS content_display,
      CASE
        WHEN NULLIF(a.summary_override, '') IS NOT NULL THEN 'editor'
        WHEN NULLIF(an.summary_en, '') IS NOT NULL THEN 'ai'
        ELSE 'feed'
      END AS summary_kind,
      (SELECT r.reviewer FROM reviews r
       WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
       LIMIT 1) AS approved_by,
      CASE WHEN json_valid(s.config) AND json_extract(s.config, '$.summaryIsBody') = 1
        THEN 1 ELSE 0 END AS body_is_abstract
    ${CARD_FROM}
    WHERE a.id = ${id} AND ${approvedArticleWhere}
    LIMIT 1`);
  const row = rows[0];
  if (!row) return null;

  const display = parseContentDisplay(row.content_display);
  const page: ArticlePage = {
    article: toViews([row])[0],
    summaryKind: row.summary_kind,
    editorApproved: row.approved_by !== "auto",
    bodyHtml: null,
    excerpted: display === "excerpt",
    bodyIsAbstract: row.body_is_abstract === 1,
  };
  // Summary sources show no body. A body_kind other than 'full' means R2 holds
  // the feed summary, which the summary block already shows.
  if (display === "summary" || row.body_kind !== "full") return page;

  // get and text() both read R2: either failing shows the summary and the
  // original link, still a 200 page.
  let md: string | null;
  try {
    const obj = await bodies.get(`bodies/${id}/${row.body_sha}.md`);
    md = obj ? await obj.text() : null;
  } catch (e) {
    console.warn({ article: id, r2: String(e) });
    md = null;
  }
  if (md === null) return page;

  // Excerpt: text blocks only, no images (no republishing of media).
  page.bodyHtml =
    display === "full" ? renderArticleMarkdown(md) : renderArticleExcerpt(md);
  return page;
}
