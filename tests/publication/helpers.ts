// Seeding for the publication tests: plain SQL against the test D1, so the
// tests do not depend on the code they check.
import { env } from "cloudflare:workers";
import { getDb } from "../../src/server/db/client";

export const db = () => getDb(env.DB);

export const DISCLAIMER =
  "For information and education only. Not investment advice.";

export async function resetPublication(): Promise<void> {
  await env.DB.batch(
    [
      "claim_evidence",
      "claims",
      "event_artifacts",
      "corrections",
      "digests",
      "event_articles",
      "events",
      "reviews",
      "analyses",
      "articles",
      "sources",
      "industries",
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}

/** Technology (id 1) and Finance (id 2, with a disclaimer), each with a source. */
export async function seedSections(): Promise<{
  technology: { industryId: number; sourceId: number };
  finance: { industryId: number; sourceId: number };
}> {
  const out: Record<string, { industryId: number; sourceId: number }> = {};
  for (const [slug, name, disclaimer] of [
    ["technology", "Technology", null],
    ["finance", "Finance", DISCLAIMER],
  ] as const) {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, disclaimer, created_at) VALUES (?1, ?2, ?3, 0) RETURNING id",
    )
      .bind(slug, name, disclaimer)
      .first<{ id: number }>();
    const src = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (?1, ?2, ?3, ?4, 'rss', 'active', 0) RETURNING id`,
    )
      .bind(
        ind!.id,
        `${name} Wire`,
        `https://${slug}.example/feed`,
        `${slug}.example`,
      )
      .first<{ id: number }>();
    out[slug] = { industryId: ind!.id, sourceId: src!.id };
  }
  return out as never;
}

export interface ArticleSeed {
  industryId: number;
  sourceId: number;
  title: string;
  /** Feed summary. */
  summary?: string | null;
  url?: string;
  publishedAt?: number | null;
  fetchedAt?: number;
  bodySha?: string;
  titleOverride?: string | null;
  summaryOverride?: string | null;
}

let counter = 0;

export async function seedArticle(a: ArticleSeed): Promise<number> {
  counter += 1;
  const url = a.url ?? `https://news.example/a/${counter}`;
  const row = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary,
       published_at, fetched_at, stage, stage_updated_at, body_sha, title_override, summary_override)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, 'analyzed', 0, ?8, ?9, ?10) RETURNING id`,
  )
    .bind(
      a.sourceId,
      a.industryId,
      url,
      a.title,
      a.summary ?? null,
      a.publishedAt === undefined ? 1_000 * counter : a.publishedAt,
      a.fetchedAt ?? 2_000 * counter,
      a.bodySha ?? "sha-current",
      a.titleOverride ?? null,
      a.summaryOverride ?? null,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function seedReview(
  articleId: number,
  decision: "approved" | "rejected",
  bodySha = "sha-current",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
     VALUES (?1, ?2, ?3, 'test', 0)
     ON CONFLICT (article_id, body_sha) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
  )
    .bind(articleId, bodySha, decision)
    .run();
}

export async function seedAnalysis(
  articleId: number,
  o: {
    titleEn?: string | null;
    summaryEn?: string | null;
    evidence?: Record<string, string>;
    createdAt?: number;
    promptVersion?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags,
       total_score, created_at, title_en, summary_en)
     VALUES (?1, ?2, '{}', 'other', ?3, 50, ?4, ?5, ?6)`,
  )
    .bind(
      articleId,
      o.promptVersion ?? "v1",
      JSON.stringify(o.evidence ?? {}),
      o.createdAt ?? 1,
      o.titleEn ?? null,
      o.summaryEn ?? null,
    )
    .run();
}

export async function seedCorrection(
  targetType: string,
  targetId: number,
  body: string,
  createdAt = 1,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO corrections (target_type, target_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(targetType, targetId, body, createdAt)
    .run();
}

export async function seedEvent(
  industryId: number,
  title: string,
  revision = 0,
): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0) RETURNING id",
  )
    .bind(industryId, title, revision)
    .first<{ id: number }>();
  return row!.id;
}

export async function seedEventArticle(
  eventId: number,
  articleId: number,
  createdAt = 0,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, ?3)",
  )
    .bind(eventId, articleId, createdAt)
    .run();
}
