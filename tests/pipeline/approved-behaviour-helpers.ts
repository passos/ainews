// Fixtures for the approved-behaviour tests (#102): one event with articles
// that are approved, not reviewed, approved for an older body version
// ("stale") or rejected. Plain SQL, so the tests do not depend on the code
// they check. Tags are random so tests need not clean the shared test D1.
import { env } from "cloudflare:workers";

export type ReviewKind = "approved" | "none" | "stale" | "rejected";

export interface SeededSection {
  industryId: number;
  tag: string;
}

export async function seedSection(
  o: { publishMode?: "auto" | "review"; primaryDomains?: string[] } = {},
): Promise<SeededSection> {
  const tag = crypto.randomUUID().slice(0, 8);
  const row = await env.DB.prepare(
    `INSERT INTO industries (slug, name, publish_mode, primary_domains, created_at)
     VALUES (?1, ?1, ?2, ?3, 1000) RETURNING id`,
  )
    .bind(
      `appr102-${tag}`,
      o.publishMode ?? "auto",
      JSON.stringify(o.primaryDomains ?? []),
    )
    .first<{ id: number }>();
  return { industryId: row!.id, tag };
}

export async function seedEvent(
  industryId: number,
  o: {
    title?: string;
    revision?: number;
    createdAt?: number;
    updatedAt?: number;
  } = {},
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
  )
    .bind(
      industryId,
      o.title ?? "Appr102 Event",
      o.revision ?? 1,
      o.createdAt ?? 1000,
      o.updatedAt ?? 1000,
    )
    .first<{ id: number }>();
  return row!.id;
}

export interface SeedArticle {
  kind: ReviewKind;
  title: string;
  summary?: string;
  publishedAt?: number;
  /** Name of this article's own source. Default `${title} Wire`. */
  sourceName?: string;
  /** `event_articles.input_revision`. Default 1. */
  inputRevision?: number;
  /** `event_articles.created_at`. Default 1000. */
  linkedAt?: number;
  /** `reviews.created_at`. Default 1000. */
  reviewedAt?: number;
  /** Total score of a selected analysis; no analysis when omitted. */
  score?: number;
  stage?: string;
  /** Own canonical URL; default random. */
  canonicalUrl?: string;
}

export interface SeededArticle {
  id: number;
  bodySha: string;
  canonicalUrl: string;
}

/** Creates the article with its own source and review, and links it to the event. */
export async function seedArticleInEvent(
  eventId: number | null,
  section: SeededSection,
  a: SeedArticle,
): Promise<SeededArticle> {
  const n = crypto.randomUUID().slice(0, 8);
  const host = `appr102-${section.tag}-${n}.test`;
  const src = await env.DB.prepare(
    `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'rss', 'active', 1000) RETURNING id`,
  )
    .bind(
      section.industryId,
      a.sourceName ?? `${a.title} Wire`,
      `https://${host}/feed`,
      host,
    )
    .first<{ id: number }>();
  const bodySha = `sha-cur-${n}`;
  const canonicalUrl = a.canonicalUrl ?? `https://${host}/post`;
  const art = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary,
       published_at, fetched_at, stage, stage_updated_at, body_sha)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?6, ?7, 1000, ?8) RETURNING id`,
  )
    .bind(
      src!.id,
      section.industryId,
      canonicalUrl,
      a.title,
      a.summary ?? `${a.title} summary`,
      a.publishedAt ?? 1000,
      a.stage ?? "grouped",
      bodySha,
    )
    .first<{ id: number }>();
  if (a.kind !== "none") {
    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, ?2, ?3, 'admin', ?4)`,
    )
      .bind(
        art!.id,
        a.kind === "stale" ? `sha-old-${n}` : bodySha,
        a.kind === "rejected" ? "rejected" : "approved",
        a.reviewedAt ?? 1000,
      )
      .run();
  }
  if (a.score !== undefined) {
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags,
         total_score, selected, created_at)
       VALUES (?1, 'v1', '{}', 'report', '{}', ?2, 1, 1000)`,
    )
      .bind(art!.id, a.score)
      .run();
  }
  if (eventId !== null) {
    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
       VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(eventId, art!.id, a.linkedAt ?? 1000, a.inputRevision ?? 1)
      .run();
  }
  return { id: art!.id, bodySha, canonicalUrl };
}
