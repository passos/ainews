import { sql } from "drizzle-orm";
import { z } from "zod";
import { utcDay } from "../../providers/budget";
import { syncRevisionDiff } from "../../pipeline/evidence/diff";
import { isSystemSource } from "../../lib/source-attribution";
import {
  DEFAULT_CONTENT_DISPLAY,
  type ContentDisplay,
} from "../../lib/content-display";
import { getDb } from "../db/client";
import { APPROVED_ARTICLE_SQL } from "../publication/articles";
import {
  conditionalReviewRevisionBumpStatement,
  revisionBumpStatement,
} from "../db/events";
import {
  analyses,
  articles,
  budgets,
  companies,
  corrections,
  discoveryRuns,
  dlqMessages,
  industries,
  llmCalls,
  reviews,
  sourceCandidates,
  sources,
} from "../db/schema";

export const FINANCE_SLUG = "finance";

export interface PendingArticleView {
  id: number;
  industryId: number;
  industrySlug: string;
  industryName: string;
  title: string;
  summary: string | null;
  canonicalUrl: string;
  url: string;
  bodySha: string | null;
  score: number | null;
  tags: string | null;
  publishedAt: number | null;
  fetchedAt: number;
}

export interface StuckArticleView {
  id: number;
  industryId: number;
  title: string;
  requeueCount: number;
  stageUpdatedAt: number;
  lastCallStatus: string | null;
  lastCallFailures: number | null;
  lastCallError: string | null;
}

// -----------------------------------------------------------------------------
// Industries
// -----------------------------------------------------------------------------

export async function listIndustries(database: D1Database) {
  const d = getDb(database);
  return d.select().from(industries).orderBy(industries.id);
}

export async function getIndustry(database: D1Database, id: number) {
  const d = getDb(database);
  const rows = await d
    .select()
    .from(industries)
    .where(sql`${industries.id} = ${id}`);
  return rows[0] ?? null;
}

export async function updateIndustryConfig(
  database: D1Database,
  data: {
    id: number;
    publishMode: "auto" | "review";
    primaryDomains: string[];
    config: string;
    disclaimer: string | null;
  },
) {
  const ind = await getIndustry(database, data.id);
  if (!ind) {
    throw new Response("Industry not found", { status: 404 });
  }

  // Validate JSON and analysis config
  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(data.config);
  } catch {
    throw new Response("Config must be valid JSON", { status: 400 });
  }
  if (typeof parsedConfig !== "object" || parsedConfig === null) {
    throw new Response("Config must be a JSON object", { status: 400 });
  }
  const configObj = parsedConfig as Record<string, unknown>;
  if (
    configObj.analysis !== undefined &&
    (typeof configObj.analysis !== "object" ||
      configObj.analysis === null ||
      Object.keys(configObj.analysis).length === 0)
  ) {
    throw new Response(
      "Invalid analysis config: analysis must be a non-empty object",
      { status: 400 },
    );
  }

  const isFinance = ind.slug.trim().toLowerCase() === FINANCE_SLUG;
  if (isFinance && data.publishMode === "auto") {
    throw new Response("Finance section cannot use auto publish_mode", {
      status: 400,
    });
  }
  if (isFinance && (!data.disclaimer || !data.disclaimer.trim())) {
    throw new Response("Finance section must retain a non-empty disclaimer", {
      status: 400,
    });
  }

  await database
    .prepare(
      `UPDATE industries
       SET publish_mode = ?1, primary_domains = ?2, config = ?3, disclaimer = ?4, config_version = config_version + 1
       WHERE id = ?5`,
    )
    .bind(
      data.publishMode,
      JSON.stringify(data.primaryDomains),
      data.config,
      data.disclaimer?.trim() ? data.disclaimer.trim() : null,
      data.id,
    )
    .run();
}

export async function createIndustry(
  database: D1Database,
  data: {
    slug: string;
    name: string;
    publishMode: "auto" | "review";
    primaryDomains: string[];
    config: string;
    disclaimer: string | null;
  },
  now = Date.now(),
) {
  const d = getDb(database);
  const cleanSlug = data.slug.trim().toLowerCase();
  const isFinance = cleanSlug === FINANCE_SLUG;
  if (isFinance && data.publishMode === "auto") {
    throw new Response("Finance section cannot use auto publish_mode", {
      status: 400,
    });
  }
  if (isFinance && (!data.disclaimer || !data.disclaimer.trim())) {
    throw new Response("Finance section must retain a non-empty disclaimer", {
      status: 400,
    });
  }

  try {
    JSON.parse(data.config);
  } catch {
    throw new Response("Config must be valid JSON", { status: 400 });
  }

  const existing = await d
    .select()
    .from(industries)
    .where(sql`${industries.slug} = ${cleanSlug}`);
  if (existing.length > 0) {
    throw new Response("Industry slug already exists", { status: 400 });
  }

  const rows = await d
    .insert(industries)
    .values({
      slug: cleanSlug,
      name: data.name.trim(),
      publishMode: data.publishMode,
      primaryDomains: JSON.stringify(data.primaryDomains),
      config: data.config,
      disclaimer: data.disclaimer?.trim() ? data.disclaimer.trim() : null,
      configVersion: 1,
      createdAt: now,
    })
    .returning();
  return rows[0];
}

// -----------------------------------------------------------------------------
// Sources
// -----------------------------------------------------------------------------

export async function listSources(
  database: D1Database,
  search?: { industryId?: number; status?: string },
) {
  const d = getDb(database);
  let query = d
    .select({
      id: sources.id,
      industryId: sources.industryId,
      industryName: industries.name,
      industrySlug: industries.slug,
      name: sources.name,
      feedUrl: sources.feedUrl,
      siteDomain: sources.siteDomain,
      kind: sources.kind,
      status: sources.status,
      pausedReason: sources.pausedReason,
      intervalMinutes: sources.intervalMinutes,
      nextFetchAt: sources.nextFetchAt,
      utcOffset: sources.utcOffset,
      config: sources.config,
      fetchRung: sources.fetchRung,
      failCount: sources.failCount,
      emptyFetches: sources.emptyFetches,
      lastOkAt: sources.lastOkAt,
      lastFailedAt: sources.lastFailedAt,
      lastError: sources.lastError,
      jinaEnabled: sources.jinaEnabled,
      contentDisplay: sources.contentDisplay,
      createdAt: sources.createdAt,
    })
    .from(sources)
    .innerJoin(industries, sql`${sources.industryId} = ${industries.id}`)
    .$dynamic();

  if (search?.industryId !== undefined) {
    query = query.where(sql`${sources.industryId} = ${search.industryId}`);
  }
  if (search?.status) {
    query = query.where(sql`${sources.status} = ${search.status}`);
  }

  return query.orderBy(sources.id);
}

export async function getSource(database: D1Database, id: number) {
  const d = getDb(database);
  const rows = await d
    .select()
    .from(sources)
    .where(sql`${sources.id} = ${id}`);
  return rows[0] ?? null;
}

/**
 * System placeholder sources are reserved: no admin write creates or sets a
 * `system:` feed URL (match: `isSystemSource`).
 */
function assertNotSystemFeed(feedUrl: string): void {
  if (isSystemSource(feedUrl)) {
    throw new Response("System feed URLs are reserved", { status: 400 });
  }
}

export async function createSource(
  database: D1Database,
  data: {
    industryId: number;
    name: string;
    feedUrl: string;
    siteDomain?: string | null;
    kind: "rss" | "html";
    intervalMinutes?: number;
    utcOffset?: string;
    config?: string;
    jinaEnabled?: number;
    contentDisplay?: ContentDisplay;
  },
) {
  const feedUrl = data.feedUrl.trim();
  assertNotSystemFeed(feedUrl);
  const d = getDb(database);
  const res = await d
    .insert(sources)
    .values({
      industryId: data.industryId,
      name: data.name,
      feedUrl,
      siteDomain: data.siteDomain ?? null,
      kind: data.kind,
      intervalMinutes: data.intervalMinutes ?? 60,
      utcOffset: data.utcOffset ?? "+00:00",
      config: data.config ?? "{}",
      jinaEnabled: data.jinaEnabled ?? 0,
      contentDisplay: data.contentDisplay ?? DEFAULT_CONTENT_DISPLAY,
      status: "candidate",
      createdAt: Date.now(),
    })
    .returning({ id: sources.id });
  return res[0]?.id;
}

export async function updateSource(
  database: D1Database,
  data: {
    id: number;
    name: string;
    feedUrl: string;
    siteDomain?: string | null;
    intervalMinutes?: number;
    utcOffset?: string;
    config?: string;
    jinaEnabled?: number;
    contentDisplay?: ContentDisplay;
  },
) {
  const feedUrl = data.feedUrl.trim();
  assertNotSystemFeed(feedUrl);
  const res = await database
    .prepare(
      `UPDATE sources
       SET name = ?1, feed_url = ?2, site_domain = ?3, interval_minutes = COALESCE(?4, interval_minutes),
           utc_offset = COALESCE(?5, utc_offset), config = COALESCE(?6, config), jina_enabled = COALESCE(?7, jina_enabled),
           content_display = COALESCE(?9, content_display)
       WHERE id = ?8 AND feed_url NOT LIKE 'system:%'`,
    )
    .bind(
      data.name,
      feedUrl,
      data.siteDomain ?? null,
      data.intervalMinutes ?? null,
      data.utcOffset ?? null,
      data.config ?? null,
      data.jinaEnabled ?? null,
      data.id,
      data.contentDisplay ?? null,
    )
    .run();
  if (res.meta.changes === 0) {
    throw new Response("Source not found or not editable", { status: 400 });
  }
}

export async function deleteSource(database: D1Database, id: number) {
  const res = await database
    .prepare(
      "DELETE FROM sources WHERE id = ?1 AND feed_url NOT LIKE 'system:%'",
    )
    .bind(id)
    .run();
  if (res.meta.changes === 0) {
    throw new Response("Source not found or not deletable", { status: 400 });
  }
}

export async function resumeSource(database: D1Database, id: number) {
  // System placeholder sources (e.g. primary documents) never get collected.
  const res = await database
    .prepare(
      `UPDATE sources
       SET status = 'active', fail_count = 0, empty_fetches = 0, paused_reason = NULL
       WHERE id = ?1 AND feed_url NOT LIKE 'system:%'`,
    )
    .bind(id)
    .run();
  if (res.meta.changes === 0) {
    throw new Response("Source not found or not resumable", { status: 400 });
  }
}

export async function triggerCollect(
  qIngest: { send: (msg: unknown) => Promise<unknown> },
  sourceId: number,
) {
  await qIngest.send({ kind: "collect", sourceId });
}

export async function listSourceCandidates(
  database: D1Database,
  search?: { industryId?: number; status?: string },
) {
  const d = getDb(database);
  const conditions = [];
  if (search?.industryId) {
    conditions.push(sql`${sourceCandidates.industryId} = ${search.industryId}`);
  }
  if (search?.status) {
    conditions.push(sql`${sourceCandidates.status} = ${search.status}`);
  }
  const whereClause = conditions.length
    ? sql.join(conditions, sql` AND `)
    : undefined;

  return d
    .select()
    .from(sourceCandidates)
    .where(whereClause)
    .orderBy(sql`${sourceCandidates.createdAt} DESC`);
}

export async function approveCandidate(
  database: D1Database,
  candidateId: number,
  now = Date.now(),
) {
  const d = getDb(database);
  const rows = await d
    .select()
    .from(sourceCandidates)
    .where(sql`${sourceCandidates.id} = ${candidateId}`);
  const candidate = rows[0];
  if (!candidate) {
    throw new Response("Candidate not found", { status: 404 });
  }

  if (candidate.requiresBrowser === 1) {
    throw new Response("Cannot approve source requiring browser rendering", {
      status: 400,
    });
  }

  const feedUrl = candidate.feedUrl.trim();
  assertNotSystemFeed(feedUrl);

  if (candidate.kind !== "rss") {
    throw new Response(
      "Cannot approve non-RSS candidate without list configuration",
      { status: 400 },
    );
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, fetch_rung, interval_minutes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, 60, ?7)
         ON CONFLICT (industry_id, feed_url) DO UPDATE SET status = 'active'`,
      )
      .bind(
        candidate.industryId,
        candidate.name || candidate.siteDomain || "",
        feedUrl,
        candidate.siteDomain,
        candidate.kind,
        candidate.fetchRung,
        now,
      ),
    database
      .prepare(`UPDATE source_candidates SET status = 'approved' WHERE id = ?1`)
      .bind(candidateId),
  ]);

  return { success: true };
}

export async function rejectCandidate(
  database: D1Database,
  data: { id: number; reason?: string },
) {
  const d = getDb(database);
  await d
    .update(sourceCandidates)
    .set({
      status: "rejected",
      rejectionReason: data.reason ?? "rejected_by_admin",
    })
    .where(sql`${sourceCandidates.id} = ${data.id}`);
  return { success: true };
}

export async function triggerDiscovery(
  database: D1Database,
  qGenerate: { send: (msg: unknown) => Promise<unknown> },
  data: { industryId: number; queries?: string[] },
  now = Date.now(),
) {
  const ind = await getIndustry(database, data.industryId);
  if (!ind) {
    throw new Response("Industry not found", { status: 404 });
  }

  const d = getDb(database);
  const inserted = await d
    .insert(discoveryRuns)
    .values({
      industryId: data.industryId,
      status: "pending",
      searchQueries: JSON.stringify(data.queries ?? []),
      createdAt: now,
    })
    .returning({ id: discoveryRuns.id });

  const runId = inserted[0].id;
  await qGenerate.send({ kind: "discover", runId });
  return { runId, status: "pending" };
}

// -----------------------------------------------------------------------------
// Review
// -----------------------------------------------------------------------------

export async function listPendingArticles(
  database: D1Database,
  search?: { industryId?: number },
): Promise<PendingArticleView[]> {
  const d = getDb(database);
  const rows = await d.all<PendingArticleView>(sql`
    SELECT
      a.id,
      a.industry_id AS industryId,
      i.slug AS industrySlug,
      i.name AS industryName,
      COALESCE(a.title_override, an.title_en, a.title) AS title,
      COALESCE(a.summary_override, an.summary_en, a.summary) AS summary,
      a.canonical_url AS canonicalUrl,
      a.url,
      a.body_sha AS bodySha,
      an.total_score AS score,
      an.evidence_tags AS tags,
      a.published_at AS publishedAt,
      a.fetched_at AS fetchedAt
    FROM articles a
    JOIN industries i ON i.id = a.industry_id
    LEFT JOIN analyses an ON an.id = (
      SELECT id FROM analyses
      WHERE article_id = a.id AND selected = 1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
    WHERE a.stage IN ('analyzed', 'grouped')
      AND NOT EXISTS (
        SELECT 1 FROM reviews r
        WHERE r.article_id = a.id AND r.body_sha = a.body_sha
      )
      ${search?.industryId !== undefined ? sql`AND a.industry_id = ${search.industryId}` : sql``}
    ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
  `);
  return rows;
}

export async function decideReview(
  database: D1Database,
  data: {
    articleId: number;
    bodySha: string;
    decision: "approved" | "rejected";
    reviewer: string;
  },
) {
  const article = await database
    .prepare("SELECT body_sha FROM articles WHERE id = ?1")
    .bind(data.articleId)
    .first<{ body_sha: string | null }>();

  if (!article || article.body_sha !== data.bodySha) {
    throw new Response("Conflict: article body has changed", { status: 409 });
  }

  const now = Date.now();
  await database.batch([
    // Atomic conditional bump executed inside transaction BEFORE inserting/updating review
    conditionalReviewRevisionBumpStatement(
      database,
      data.articleId,
      data.bodySha,
      data.decision,
      now,
    ),
    database
      .prepare(
        `UPDATE event_articles
         SET input_revision = (SELECT revision FROM events WHERE id = event_articles.event_id)
         WHERE article_id = ?1
           AND ?2 = 'approved'
           AND NOT EXISTS (
             SELECT 1 FROM reviews
             WHERE article_id = ?1 AND decision = 'approved' AND body_sha = ?3
           )`,
      )
      .bind(data.articleId, data.decision, data.bodySha),
    database
      .prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (article_id, body_sha)
         DO UPDATE SET decision = excluded.decision, reviewer = excluded.reviewer, created_at = excluded.created_at`,
      )
      .bind(data.articleId, data.bodySha, data.decision, data.reviewer, now),
    // Issue #83: financial_facts.superseded_by follows the current reviews.
    // Runs on every decision, after the reviews write, so it sees the new
    // decision. For each fact in the same (company, concept, unit, period end)
    // group as this article's facts, the pointer is recomputed from scratch:
    // the newest fact with a larger id in an approved amendment (form contains
    // "/A") of ANOTHER filing (a filing never supersedes its own facts), or
    // NULL. It is "the newest approved amendment fact", not "the next
    // link in a chain", so the result does not depend on decision order. The
    // only reader, src/pipeline/artifacts/build.ts, checks
    // `superseded_by IS NULL`, so only NULL vs non-NULL matters there.
    database
      .prepare(
        `UPDATE financial_facts
         SET superseded_by = (
           SELECT nf.id FROM financial_facts nf
           JOIN filings fl ON fl.id = nf.filing_id
           JOIN articles a ON a.id = fl.article_id
           WHERE instr(fl.form, '/A') > 0
             AND nf.company_id = financial_facts.company_id
             AND nf.concept = financial_facts.concept
             AND nf.unit = financial_facts.unit
             AND nf.period_end = financial_facts.period_end
             AND nf.id > financial_facts.id
             AND nf.filing_id <> financial_facts.filing_id
             AND ${APPROVED_ARTICLE_SQL}
           ORDER BY nf.id DESC LIMIT 1
         )
         WHERE (company_id, concept, unit, period_end) IN (
           SELECT nf.company_id, nf.concept, nf.unit, nf.period_end
           FROM financial_facts nf
           JOIN filings fl ON fl.id = nf.filing_id
           WHERE fl.article_id = ?1
         )`,
      )
      .bind(data.articleId),
  ]);
}

export async function listStuckArticles(
  database: D1Database,
): Promise<StuckArticleView[]> {
  const d = getDb(database);
  const rows = await d.all<StuckArticleView>(sql`
    SELECT
      a.id,
      a.industry_id AS industryId,
      COALESCE(a.title_override, a.title) AS title,
      a.requeue_count AS requeueCount,
      a.stage_updated_at AS stageUpdatedAt,
      c.status AS lastCallStatus,
      c.failures AS lastCallFailures,
      c.error AS lastCallError
    FROM articles a
    LEFT JOIN llm_calls c ON c.id = (
      SELECT id FROM llm_calls
      WHERE logical_key LIKE 'write:' || a.id || ':%' OR logical_key LIKE 'analyze:' || a.id || ':%'
      ORDER BY id DESC LIMIT 1
    )
    WHERE a.stage = 'body_ready' AND a.requeue_count >= 3
    ORDER BY a.stage_updated_at DESC
  `);
  return rows;
}

// -----------------------------------------------------------------------------
// Articles, Overrides & Corrections
// -----------------------------------------------------------------------------

export async function getArticle(database: D1Database, id: number) {
  const d = getDb(database);
  const art = await d
    .select()
    .from(articles)
    .where(sql`${articles.id} = ${id}`);
  if (art.length === 0) return null;

  const revs = await d
    .select()
    .from(reviews)
    .where(sql`${reviews.articleId} = ${id}`)
    .orderBy(sql`${reviews.createdAt} DESC`);

  const anals = await d
    .select()
    .from(analyses)
    .where(sql`${analyses.articleId} = ${id}`)
    .orderBy(sql`${analyses.createdAt} DESC, ${analyses.id} DESC`);

  const corrs = await d
    .select()
    .from(corrections)
    .where(
      sql`${corrections.targetType} IN ('article', 'articles') AND ${corrections.targetId} = ${id}`,
    )
    .orderBy(sql`${corrections.createdAt} DESC`);

  return {
    article: art[0],
    reviews: revs,
    analyses: anals,
    corrections: corrs,
  };
}

export async function updateArticleOverride(
  database: D1Database,
  data: {
    articleId: number;
    titleOverride?: string | null;
    summaryOverride?: string | null;
  },
) {
  const title = data.titleOverride?.trim() ? data.titleOverride.trim() : null;
  const summary = data.summaryOverride?.trim()
    ? data.summaryOverride.trim()
    : null;

  const now = Date.now();
  await database.batch([
    database
      .prepare(
        "UPDATE articles SET title_override = ?1, summary_override = ?2 WHERE id = ?3",
      )
      .bind(title, summary, data.articleId),
    revisionBumpStatement(database, data.articleId, now),
  ]);
}

export async function changeArticleIndustry(
  database: D1Database,
  data: { articleId: number; industryId: number },
) {
  const inEvent = await database
    .prepare("SELECT 1 FROM event_articles WHERE article_id = ?1")
    .bind(data.articleId)
    .first<{ 1: number }>();

  if (inEvent) {
    throw new Response("Cannot change section: article is part of an event", {
      status: 409,
    });
  }

  const target = await getIndustry(database, data.industryId);
  const statements: D1PreparedStatement[] = [
    database
      .prepare("UPDATE articles SET industry_id = ?1 WHERE id = ?2")
      .bind(data.industryId, data.articleId),
  ];

  if (target?.slug.trim().toLowerCase() === FINANCE_SLUG) {
    // Finance requires human review: revoke any auto-approvals
    const hadAutoApproval = await database
      .prepare(
        "SELECT 1 FROM reviews WHERE article_id = ?1 AND reviewer = 'auto' AND decision = 'approved'",
      )
      .bind(data.articleId)
      .first();
    if (hadAutoApproval) {
      statements.push(
        revisionBumpStatement(database, data.articleId, Date.now()),
      );
    }
    statements.push(
      database
        .prepare(
          "DELETE FROM reviews WHERE article_id = ?1 AND reviewer = 'auto'",
        )
        .bind(data.articleId),
    );
  }

  await database.batch(statements);
}

const REANALYZE_INPUT = z.object({
  articleId: z.number().int().positive(),
  expectedStage: z.enum([
    "collected",
    "body_ready",
    "analyzed",
    "grouped",
    "dropped",
  ]),
});

/**
 * Validates the reanalyze request. A client bundle loaded before the deploy
 * sends no `expectedStage`; that must be a 400, not an undefined bind (500).
 */
export function parseReanalyzeInput(data: unknown) {
  const parsed = REANALYZE_INPUT.safeParse(data);
  if (!parsed.success) {
    throw new Response("Invalid reanalyze request", { status: 400 });
  }
  return parsed.data;
}

export async function reanalyzeArticle(
  database: D1Database,
  qIngest: { send: (msg: unknown) => Promise<unknown> },
  data: { articleId: number; expectedStage: string },
) {
  const row = await database
    .prepare("SELECT analysis_generation FROM articles WHERE id = ?1")
    .bind(data.articleId)
    .first<{ analysis_generation: number }>();
  if (!row) throw new Response("Article not found", { status: 404 });
  const now = Date.now();
  // Exactly two statements: the events UPDATE reads changes() of the
  // articles UPDATE right before it. Insert nothing between them.
  const [moved] = await database.batch([
    // Architecture §5: stage with stage_updated_at and requeue_count.
    // The generation gives the next analysis new ledger keys and a new
    // analyses row; no llm_calls or analyses row is deleted (#81).
    database
      .prepare(
        `UPDATE articles
         SET stage = 'body_ready', stage_updated_at = ?1, requeue_count = 0,
             analysis_generation = analysis_generation + 1
         WHERE id = ?2 AND stage = ?3 AND analysis_generation = ?4
           AND body_sha IS NOT NULL`,
      )
      .bind(now, data.articleId, data.expectedStage, row.analysis_generation),
    // revisionBumpStatement, but only if the UPDATE above changed the row.
    database
      .prepare(
        `UPDATE events SET revision = revision + 1, updated_at = ?1
         WHERE id = (SELECT event_id FROM event_articles WHERE article_id = ?2)
           AND changes() = 1`,
      )
      .bind(now, data.articleId),
  ]);
  if (moved.meta.changes !== 1) {
    throw new Response(
      "The article changed or has no body; reload and try again",
      { status: 409 },
    );
  }
  await qIngest.send({ kind: "analyze", articleId: data.articleId });
}

export async function retractArticle(
  database: D1Database,
  articleId: number,
  reviewer: string,
) {
  const article = await database
    .prepare("SELECT body_sha FROM articles WHERE id = ?1")
    .bind(articleId)
    .first<{ body_sha: string | null }>();
  if (!article || !article.body_sha) {
    throw new Response("Article or body not found", { status: 404 });
  }
  await decideReview(database, {
    articleId,
    bodySha: article.body_sha,
    decision: "rejected",
    reviewer,
  });
}

export async function createCorrection(
  database: D1Database,
  data: { targetType: string; targetId: number; body: string },
) {
  const now = Date.now();
  await database
    .prepare(
      "INSERT INTO corrections (target_type, target_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(data.targetType, data.targetId, data.body, now)
    .run();
}

// -----------------------------------------------------------------------------
// Ledger & Budget
// -----------------------------------------------------------------------------

export async function listLedgerCalls(
  database: D1Database,
  search?: { channel?: string; status?: string; page?: number },
) {
  const d = getDb(database);
  const page = Math.max(1, search?.page ?? 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  let query = d.select().from(llmCalls).$dynamic();
  if (search?.channel) {
    query = query.where(sql`${llmCalls.channel} = ${search.channel}`);
  }
  if (search?.status) {
    query = query.where(sql`${llmCalls.status} = ${search.status}`);
  }

  return query
    .orderBy(sql`${llmCalls.id} DESC`)
    .limit(limit)
    .offset(offset);
}

export async function getBudgetSummary(database: D1Database, today?: string) {
  const day = today ?? utcDay(Date.now());
  const d = getDb(database);
  const budgetRows = await d
    .select()
    .from(budgets)
    .where(sql`${budgets.day} = ${day}`);
  const capsSetting = await database
    .prepare("SELECT value FROM settings WHERE key = 'budget.caps'")
    .first<{ value: string }>();

  return {
    day,
    budgets: budgetRows,
    caps: JSON.parse(capsSetting?.value ?? "{}"),
  };
}

export async function reconcileUnknownCall(
  database: D1Database,
  data: { callId: number; status: "completed" | "failed"; costMicros?: number },
) {
  const call = await database
    .prepare(
      "SELECT id, status, channel, budget_day, estimated_micros FROM llm_calls WHERE id = ?1",
    )
    .bind(data.callId)
    .first<{
      id: number;
      status: string;
      channel: string;
      budget_day: string | null;
      estimated_micros: number | null;
    }>();

  if (!call || call.status !== "unknown") {
    throw new Response("Call is not in unknown status", { status: 409 });
  }

  const now = Date.now();
  const actualCost = Math.max(0, data.costMicros ?? 0);
  const reserved = call.estimated_micros ?? 0;
  const budgetDay = call.budget_day ?? utcDay(now);

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE llm_calls
         SET status = ?1, cost_micros = ?2, updated_at = ?3,
             response_json = CASE WHEN ?1 = 'completed' AND response_json IS NULL THEN '{}' ELSE response_json END
         WHERE id = ?4 AND status = 'unknown'`,
      )
      .bind(data.status, actualCost, now, data.callId),
  ];

  if (data.status === "completed") {
    statements.push(
      database
        .prepare(
          `UPDATE budgets
           SET spent_micros = spent_micros + ?1, reserved_micros = reserved_micros - ?2
           WHERE day = ?3 AND channel = ?4 AND changes() = 1`,
        )
        .bind(actualCost, reserved, budgetDay, call.channel),
    );
  } else {
    statements.push(
      database
        .prepare(
          `UPDATE budgets
           SET reserved_micros = reserved_micros - ?1
           WHERE day = ?2 AND channel = ?3 AND changes() = 1`,
        )
        .bind(reserved, budgetDay, call.channel),
    );
  }

  const results = await database.batch(statements);
  if (results[0].meta.changes === 0) {
    throw new Response("Conflict: call was modified concurrently", {
      status: 409,
    });
  }
}

export async function updateDailyCap(
  database: D1Database,
  data: { channel: "workers_ai" | "gateway" | "jina"; capMicros: number },
  today?: string,
) {
  const day = today ?? utcDay(Date.now());
  const now = Date.now();

  await database.batch([
    database
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('budget.caps', json_object(?1, ?2), ?3)
         ON CONFLICT (key) DO UPDATE SET
           value = json_set(COALESCE(settings.value, '{}'), '$.' || ?1, ?2),
           updated_at = ?3`,
      )
      .bind(data.channel, data.capMicros, now),
    database
      .prepare(
        `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
         VALUES (?1, ?2, ?3, 0, 0)
         ON CONFLICT (day, channel) DO UPDATE SET cap_micros = excluded.cap_micros`,
      )
      .bind(day, data.channel, data.capMicros),
  ]);
}

// -----------------------------------------------------------------------------
// DLQ
// -----------------------------------------------------------------------------

export async function listDlqMessages(database: D1Database) {
  const d = getDb(database);
  return d
    .select()
    .from(dlqMessages)
    .orderBy(sql`${dlqMessages.receivedAt} DESC`);
}

export async function replayDlqMessage(
  database: D1Database,
  queues: {
    qIngest: { send: (msg: unknown) => Promise<unknown> };
    qGroup: { send: (msg: unknown) => Promise<unknown> };
    qGenerate: { send: (msg: unknown) => Promise<unknown> };
  },
  messageId: string,
) {
  const msg = await database
    .prepare("SELECT id, kind, body_json FROM dlq_messages WHERE id = ?1")
    .bind(messageId)
    .first<{ id: string; kind: string | null; body_json: string }>();

  if (!msg) {
    throw new Response("Message not found", { status: 404 });
  }
  if (!msg.kind) {
    throw new Response("Cannot replay: message has no kind", { status: 400 });
  }

  const body = JSON.parse(msg.body_json);
  switch (msg.kind) {
    case "collect":
    case "body":
    case "analyze":
      await queues.qIngest.send(body);
      break;
    case "group":
      await queues.qGroup.send(body);
      break;
    default:
      await queues.qGenerate.send(body);
      break;
  }

  await database
    .prepare("UPDATE dlq_messages SET replayed_at = ?1 WHERE id = ?2")
    .bind(Date.now(), messageId)
    .run();
}

// -----------------------------------------------------------------------------
// Digests
// -----------------------------------------------------------------------------

export interface AdminDigestItem {
  eventId: number;
  eventRevision?: number;
  title: string;
  oneLiner: string;
  sourceName: string;
  articleCount: number;
}

export interface AdminDigestRow {
  id: number;
  industryId: number;
  industrySlug: string;
  industryName: string;
  kind: "daily" | "weekly";
  periodStart: string;
  status: string;
  intro: string;
  itemCount: number;
  items: AdminDigestItem[];
  createdAt: number;
  publishedAt: number | null;
  emailedAt: number | null;
}

export async function listAdminDigests(database: D1Database): Promise<{
  pending: AdminDigestRow[];
  published: AdminDigestRow[];
}> {
  const { results: rows } = await database
    .prepare(
      `SELECT
        d.id,
        d.industry_id AS industryId,
        i.slug AS industrySlug,
        i.name AS industryName,
        d.kind AS kind,
        d.period_start AS periodStart,
        d.status,
        d.intro,
        json_array_length(d.items_json) AS itemCount,
        d.items_json AS itemsJson,
        d.created_at AS createdAt,
        d.published_at AS publishedAt,
        d.emailed_at AS emailedAt
      FROM digests d
      JOIN industries i ON i.id = d.industry_id
      WHERE d.status = 'ready'
      ORDER BY d.period_start DESC, d.id DESC`,
    )
    .all<{
      id: number;
      industryId: number;
      industrySlug: string;
      industryName: string;
      kind: "daily" | "weekly";
      periodStart: string;
      status: string;
      intro: string;
      itemCount: number;
      itemsJson: string;
      createdAt: number;
      publishedAt: number | null;
      emailedAt: number | null;
    }>();

  const pending: AdminDigestRow[] = [];
  const published: AdminDigestRow[] = [];

  for (const r of rows) {
    let items: AdminDigestItem[];
    try {
      items = JSON.parse(r.itemsJson || "[]");
    } catch {
      items = [];
    }
    const itemRow: AdminDigestRow = {
      id: r.id,
      industryId: r.industryId,
      industrySlug: r.industrySlug,
      industryName: r.industryName,
      kind: r.kind,
      periodStart: r.periodStart,
      status: r.status,
      intro: r.intro,
      itemCount: r.itemCount ?? items.length,
      items,
      createdAt: r.createdAt,
      publishedAt: r.publishedAt,
      emailedAt: r.emailedAt,
    };
    if (r.publishedAt === null) {
      pending.push(itemRow);
    } else {
      published.push(itemRow);
    }
  }

  return { pending, published };
}

export async function publishDigest(
  database: D1Database,
  digestId: number,
  now = Date.now(),
): Promise<boolean> {
  const res = await database
    .prepare(
      "UPDATE digests SET published_at = ?1 WHERE id = ?2 AND published_at IS NULL",
    )
    .bind(now, digestId)
    .run();
  return res.meta.changes === 1;
}

// -----------------------------------------------------------------------------
// Artifacts (M2 #13)
// -----------------------------------------------------------------------------

export interface AdminArtifactView {
  id: number;
  eventId: number;
  eventTitle: string;
  eventRevision: number;
  industryName: string;
  industrySlug: string;
  type: string;
  audience: string;
  inputRevision: number;
  model: string;
  content: string;
  status: string;
  createdAt: number;
}

export async function listPendingArtifacts(
  database: D1Database,
): Promise<AdminArtifactView[]> {
  const d = getDb(database);
  const rows = await d.all<AdminArtifactView>(sql`
    SELECT
      ea.id,
      ea.event_id AS eventId,
      e.title AS eventTitle,
      e.revision AS eventRevision,
      i.name AS industryName,
      i.slug AS industrySlug,
      ea.type,
      ea.audience,
      ea.input_revision AS inputRevision,
      ea.model,
      ea.content,
      ea.status,
      ea.created_at AS createdAt
    FROM event_artifacts ea
    JOIN events e ON e.id = ea.event_id
    JOIN industries i ON i.id = e.industry_id
    WHERE ea.status = 'pending_review'
      AND (ea.input_revision = e.revision OR (ea.type = 'revision_diff' AND ea.input_revision <= e.revision))
    ORDER BY ea.created_at DESC
  `);
  return rows;
}

export async function reviewArtifact(
  database: D1Database,
  data: {
    artifactId: number;
    decision: "approved" | "rejected";
    expectedRevision: number;
  },
): Promise<boolean> {
  const targetStatus = data.decision === "approved" ? "published" : "rejected";
  const res = await database
    .prepare(
      `UPDATE event_artifacts
       SET status = ?1
       WHERE id = ?2
         AND status = 'pending_review'
         AND input_revision = ?3
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.id = event_artifacts.event_id
             AND (e.revision = ?3 OR (event_artifacts.type = 'revision_diff' AND e.revision >= ?3))
         )`,
    )
    .bind(targetStatus, data.artifactId, data.expectedRevision)
    .run();

  return res.meta.changes === 1;
}

// -----------------------------------------------------------------------------
// Claims & Evidence (M2 #14)
// -----------------------------------------------------------------------------

export interface PendingCitationRow {
  id: number;
  claimId: number;
  articleId: number;
  articleTitle: string;
  articleUrl: string;
  sourceName: string;
  quote: string;
  stance: "support" | "dispute";
  isPrimarySource: boolean;
  verified: boolean;
}

export interface PendingClaimRow {
  id: number;
  eventId: number;
  eventTitle: string;
  industryName: string;
  claimText: string;
  claimType: string;
  consensusStatus: string;
  primarySourcePreferred: number;
  inputRevision: number;
  model: string;
  status: string;
  createdAt: number;
  citations: PendingCitationRow[];
}

export async function listPendingClaims(
  database: D1Database,
): Promise<PendingClaimRow[]> {
  const [claimsRes, citationsRes] = await Promise.all([
    database
      .prepare(
        `SELECT
           c.id,
           c.event_id AS eventId,
           e.title AS eventTitle,
           i.name AS industryName,
           c.claim_text AS claimText,
           c.claim_type AS claimType,
           c.consensus_status AS consensusStatus,
           c.primary_source_preferred AS primarySourcePreferred,
           c.input_revision AS inputRevision,
           c.model,
           c.status,
           c.created_at AS createdAt
         FROM claims c
         JOIN events e ON e.id = c.event_id
         JOIN industries i ON i.id = e.industry_id
         WHERE c.status = 'pending_review'
           AND c.input_revision = e.revision
           AND c.claim_text NOT LIKE '[%]'
         ORDER BY c.created_at DESC`,
      )
      .all<Omit<PendingClaimRow, "citations">>(),
    database
      .prepare(
        `SELECT
           ce.id,
           ce.claim_id AS claimId,
           ce.article_id AS articleId,
           COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title) AS articleTitle,
           a.canonical_url AS articleUrl,
           COALESCE(NULLIF(s.name, ''), s.site_domain, 'Unknown source') AS sourceName,
           ce.quote,
           ce.stance,
           ce.is_primary_source AS isPrimarySource,
           ce.verified
         FROM claim_evidence ce
         JOIN claims c ON c.id = ce.claim_id
         JOIN articles a ON a.id = ce.article_id
         JOIN sources s ON s.id = a.source_id
         LEFT JOIN analyses an ON an.id = (
           SELECT id FROM analyses
           WHERE article_id = a.id AND selected = 1
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         )
         WHERE c.status = 'pending_review'
           AND c.input_revision = (SELECT revision FROM events WHERE id = c.event_id)
         ORDER BY ce.is_primary_source DESC, ce.id ASC`,
      )
      .all<{
        id: number;
        claimId: number;
        articleId: number;
        articleTitle: string | null;
        articleUrl: string;
        sourceName: string;
        quote: string;
        stance: string;
        isPrimarySource: number;
        verified: number;
      }>(),
  ]);

  const citationsByClaimId = new Map<number, PendingCitationRow[]>();
  for (const r of citationsRes.results ?? []) {
    const list = citationsByClaimId.get(r.claimId) ?? [];
    list.push({
      id: r.id,
      claimId: r.claimId,
      articleId: r.articleId,
      articleTitle: r.articleTitle ?? "Untitled",
      articleUrl: r.articleUrl,
      sourceName: r.sourceName,
      quote: r.quote,
      stance: r.stance as "support" | "dispute",
      isPrimarySource: r.isPrimarySource === 1,
      verified: r.verified === 1,
    });
    citationsByClaimId.set(r.claimId, list);
  }

  return (claimsRes.results ?? []).map((c) => ({
    ...c,
    citations: citationsByClaimId.get(c.id) ?? [],
  }));
}

export async function reviewClaim(
  database: D1Database,
  data: {
    claimId: number;
    decision: "approved" | "rejected";
    expectedRevision: number;
  },
): Promise<boolean> {
  const targetStatus = data.decision === "approved" ? "published" : "rejected";
  const res = await database
    .prepare(
      `UPDATE claims
       SET status = ?1
       WHERE id = ?2
         AND status = 'pending_review'
         AND input_revision = ?3
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.id = claims.event_id
             AND e.revision = ?3
         )`,
    )
    .bind(targetStatus, data.claimId, data.expectedRevision)
    .run();

  const changes = res.meta.changes ?? 0;

  // Retrieve current claim state to support idempotent retries / diff synchronization
  const claim = await database
    .prepare(
      `SELECT event_id, status FROM claims
       WHERE id = ?1
         AND input_revision = ?2
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.id = claims.event_id
             AND e.revision = ?2
         )`,
    )
    .bind(data.claimId, data.expectedRevision)
    .first<{ event_id: number; status: string }>();

  if (!claim) {
    return false;
  }

  if (claim.status === "published" && data.decision === "approved") {
    await syncRevisionDiff(
      database,
      claim.event_id,
      data.expectedRevision,
      "published",
      Date.now(),
    );
    return true;
  }

  return changes === 1 || claim.status === targetStatus;
}

// -----------------------------------------------------------------------------
// Ask Newsren (M2 #15)
// -----------------------------------------------------------------------------

export interface QuestionCitationItem {
  articleId: number;
  bodySha: string;
  quote: string;
  claim: string;
  startOffset: number;
  endOffset: number;
  verified: boolean;
  isPrimarySource: boolean;
}

export interface QuestionSupplementalFetchItem {
  url: string;
  rung: number | null;
  status: "ok" | "blocked" | "failed";
}

export interface QuestionItem {
  id: number;
  question: string;
  scopeType: "event" | "global";
  eventId: number | null;
  status: "pending" | "processing" | "completed" | "failed";
  answer: string | null;
  unverified: string[] | null;
  citations: QuestionCitationItem[] | null;
  refusal: boolean;
  supplementalFetched: QuestionSupplementalFetchItem[] | null;
  costMicros: number;
  promptVersion: string;
  model: string;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
}

export async function listQuestions(
  database: D1Database,
  limit = 50,
): Promise<QuestionItem[]> {
  const rows = await database
    .prepare(`SELECT * FROM questions ORDER BY created_at DESC LIMIT ?1`)
    .bind(limit)
    .all<Record<string, unknown>>();

  return (rows.results ?? []).map((r) => ({
    id: Number(r.id),
    question: String(r.question ?? ""),
    scopeType: r.scope_type === "event" ? "event" : "global",
    eventId:
      r.event_id !== null && r.event_id !== undefined
        ? Number(r.event_id)
        : null,
    status: (r.status as QuestionItem["status"]) ?? "pending",
    answer:
      r.answer !== null && r.answer !== undefined ? String(r.answer) : null,
    unverified: r.unverified ? JSON.parse(String(r.unverified)) : null,
    citations: r.citations ? JSON.parse(String(r.citations)) : null,
    refusal: r.refusal === 1,
    supplementalFetched: r.supplemental_fetched
      ? JSON.parse(String(r.supplemental_fetched))
      : null,
    costMicros: Number(r.cost_micros ?? 0),
    promptVersion: String(r.prompt_version ?? ""),
    model: String(r.model ?? ""),
    errorMessage:
      r.error_message !== null && r.error_message !== undefined
        ? String(r.error_message)
        : null,
    createdAt: Number(r.created_at),
    completedAt:
      r.completed_at !== null && r.completed_at !== undefined
        ? Number(r.completed_at)
        : null,
  }));
}

export async function getQuestion(
  database: D1Database,
  id: number,
): Promise<QuestionItem | null> {
  const r = await database
    .prepare(`SELECT * FROM questions WHERE id = ?1`)
    .bind(id)
    .first<Record<string, unknown>>();

  if (!r) return null;

  return {
    id: Number(r.id),
    question: String(r.question ?? ""),
    scopeType: r.scope_type === "event" ? "event" : "global",
    eventId:
      r.event_id !== null && r.event_id !== undefined
        ? Number(r.event_id)
        : null,
    status: (r.status as QuestionItem["status"]) ?? "pending",
    answer:
      r.answer !== null && r.answer !== undefined ? String(r.answer) : null,
    unverified: r.unverified ? JSON.parse(String(r.unverified)) : null,
    citations: r.citations ? JSON.parse(String(r.citations)) : null,
    refusal: r.refusal === 1,
    supplementalFetched: r.supplemental_fetched
      ? JSON.parse(String(r.supplemental_fetched))
      : null,
    costMicros: Number(r.cost_micros ?? 0),
    promptVersion: String(r.prompt_version ?? ""),
    model: String(r.model ?? ""),
    errorMessage:
      r.error_message !== null && r.error_message !== undefined
        ? String(r.error_message)
        : null,
    createdAt: Number(r.created_at),
    completedAt:
      r.completed_at !== null && r.completed_at !== undefined
        ? Number(r.completed_at)
        : null,
  };
}

export async function createQuestion(
  database: D1Database,
  data: {
    question: string;
    scopeType?: "event" | "global";
    eventId?: number;
  },
  now = Date.now(),
): Promise<number> {
  const scopeType = data.scopeType ?? "global";
  const eventId = scopeType === "event" ? (data.eventId ?? null) : null;
  const res = await database
    .prepare(
      `INSERT INTO questions (
        question, scope_type, event_id, status, prompt_version, model, created_at
      ) VALUES (?1, ?2, ?3, 'pending', 'ask:v1', 'default', ?4)`,
    )
    .bind(data.question.trim(), scopeType, eventId, now)
    .run();

  return Number(res.meta.last_row_id);
}

export interface AdminWatchItem {
  id: number;
  slug: string;
  question: string;
  criteria: string;
  keywords: string[];
  industryId: number | null;
  industryName: string | null;
  status: "active" | "paused";
  hitCount: number;
  createdAt: number;
  updatedAt: number;
}

export async function listWatches(
  database: D1Database,
): Promise<AdminWatchItem[]> {
  const { results } = await database
    .prepare(
      `SELECT
        w.id,
        w.slug,
        w.question,
        w.criteria,
        w.keywords,
        w.industry_id,
        i.name AS industry_name,
        w.status,
        w.created_at,
        w.updated_at,
        (SELECT COUNT(*) FROM watch_hits wh WHERE wh.watch_id = w.id) AS hit_count
      FROM watches w
      LEFT JOIN industries i ON i.id = w.industry_id
      ORDER BY w.created_at DESC`,
    )
    .all<{
      id: number;
      slug: string;
      question: string;
      criteria: string;
      keywords: string;
      industry_id: number | null;
      industry_name: string | null;
      status: "active" | "paused";
      created_at: number;
      updated_at: number;
      hit_count: number;
    }>();

  if (!results) return [];

  return results.map((r) => {
    let keywords: string[] = [];
    try {
      const parsed = JSON.parse(r.keywords);
      if (Array.isArray(parsed)) {
        keywords = parsed.filter((k): k is string => typeof k === "string");
      }
    } catch {
      keywords = r.keywords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return {
      id: r.id,
      slug: r.slug,
      question: r.question,
      criteria: r.criteria,
      keywords,
      industryId: r.industry_id,
      industryName: r.industry_name,
      status: r.status,
      hitCount: Number(r.hit_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export async function createWatch(
  database: D1Database,
  data: {
    slug: string;
    question: string;
    criteria: string;
    keywords: string[];
    industryId?: number | null;
    status?: "active" | "paused";
  },
  now = Date.now(),
): Promise<number> {
  const cleanedKeywords = (data.keywords || [])
    .map((k) => k.trim())
    .filter(Boolean);
  if (cleanedKeywords.length === 0) {
    throw new Error("Watch must have at least one keyword");
  }

  const res = await database
    .prepare(
      `INSERT INTO watches (
        slug, question, criteria, keywords, industry_id, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      data.slug.trim(),
      data.question.trim(),
      data.criteria.trim(),
      JSON.stringify(cleanedKeywords),
      data.industryId ?? null,
      data.status ?? "active",
      now,
      now,
    )
    .run();

  return Number(res.meta.last_row_id);
}

export async function updateWatch(
  database: D1Database,
  data: {
    id: number;
    question?: string;
    criteria?: string;
    keywords?: string[];
    industryId?: number | null;
    status?: "active" | "paused";
  },
  now = Date.now(),
): Promise<void> {
  const updates: string[] = ["updated_at = ?2"];
  const values: unknown[] = [data.id, now];
  let paramIndex = 3;

  if (data.question !== undefined) {
    updates.push(`question = ?${paramIndex++}`);
    values.push(data.question.trim());
  }
  if (data.criteria !== undefined) {
    updates.push(`criteria = ?${paramIndex++}`);
    values.push(data.criteria.trim());
  }
  if (data.keywords !== undefined) {
    const cleanedKeywords = data.keywords.map((k) => k.trim()).filter(Boolean);
    if (cleanedKeywords.length === 0) {
      throw new Error("Watch must have at least one keyword");
    }
    updates.push(`keywords = ?${paramIndex++}`);
    values.push(JSON.stringify(cleanedKeywords));
  }
  if (data.industryId !== undefined) {
    updates.push(`industry_id = ?${paramIndex++}`);
    values.push(data.industryId);
  }
  if (data.status !== undefined) {
    updates.push(`status = ?${paramIndex}`);
    values.push(data.status);
  }

  await database
    .prepare(`UPDATE watches SET ${updates.join(", ")} WHERE id = ?1`)
    .bind(...values)
    .run();
}

export async function listWatchHits(
  database: D1Database,
  watchId: number,
): Promise<
  {
    id: number;
    eventId: number;
    eventTitle: string;
    eventRevision: number;
    hitAt: number;
    summary: string;
    rationale: string;
    status: WatchHitStatus;
  }[]
> {
  const { results } = await database
    .prepare(
      `SELECT
        wh.id,
        wh.event_id,
        e.title AS event_title,
        wh.event_revision,
        wh.hit_at,
        wh.summary,
        wh.rationale,
        wh.status
      FROM watch_hits wh
      JOIN events e ON e.id = wh.event_id
      WHERE wh.watch_id = ?1
      ORDER BY wh.hit_at DESC`,
    )
    .bind(watchId)
    .all<{
      id: number;
      event_id: number;
      event_title: string;
      event_revision: number;
      hit_at: number;
      summary: string;
      rationale: string;
      status: WatchHitStatus;
    }>();

  if (!results) return [];

  return results.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    eventTitle: r.event_title,
    eventRevision: r.event_revision,
    hitAt: r.hit_at,
    summary: r.summary,
    rationale: r.rationale,
    status: r.status,
  }));
}

export type WatchHitStatus = "published" | "pending_review" | "rejected";

export interface PendingWatchHit {
  id: number;
  watchId: number;
  watchSlug: string;
  watchQuestion: string;
  eventId: number;
  eventTitle: string;
  eventRevision: number;
  industryName: string;
  industrySlug: string;
  hitAt: number;
  summary: string;
  rationale: string;
}

/** Watch hits that wait for review, newest first. */
export async function listPendingWatchHits(
  database: D1Database,
): Promise<PendingWatchHit[]> {
  const { results } = await database
    .prepare(
      `SELECT
        wh.id AS id,
        wh.watch_id AS watchId,
        w.slug AS watchSlug,
        w.question AS watchQuestion,
        wh.event_id AS eventId,
        e.title AS eventTitle,
        wh.event_revision AS eventRevision,
        i.name AS industryName,
        i.slug AS industrySlug,
        wh.hit_at AS hitAt,
        wh.summary AS summary,
        wh.rationale AS rationale
      FROM watch_hits wh
      JOIN watches w ON w.id = wh.watch_id
      JOIN events e ON e.id = wh.event_id
      JOIN industries i ON i.id = e.industry_id
      WHERE wh.status = 'pending_review'
      ORDER BY wh.hit_at DESC, wh.id DESC`,
    )
    .all<PendingWatchHit>();
  return results ?? [];
}

/**
 * Decides a pending hit once. Not bound to the event's current revision: the
 * hit records progress at its own revision, and later retractions are
 * filtered at read time by the article guards in getWatchView.
 */
export async function reviewWatchHit(
  database: D1Database,
  data: { hitId: number; decision: "approved" | "rejected" },
): Promise<boolean> {
  const targetStatus = data.decision === "approved" ? "published" : "rejected";
  const res = await database
    .prepare(
      `UPDATE watch_hits SET status = ?1
       WHERE id = ?2 AND status = 'pending_review'`,
    )
    .bind(targetStatus, data.hitId)
    .run();
  return res.meta.changes === 1;
}

// -----------------------------------------------------------------------------
// Tracked Companies (EDGAR §4)
// -----------------------------------------------------------------------------

export async function listCompanies(database: D1Database) {
  const d = getDb(database);
  return d.select().from(companies).orderBy(companies.ticker);
}

export async function createCompany(
  database: D1Database,
  data: { cik: string; ticker: string; name: string },
) {
  const d = getDb(database);
  const now = Date.now();
  const digits = data.cik.replace(/\D/g, "");
  const formattedCik = digits.padStart(10, "0");
  const upperTicker = data.ticker.trim().toUpperCase();

  const [created] = await d
    .insert(companies)
    .values({
      cik: formattedCik,
      ticker: upperTicker,
      name: data.name.trim(),
      tracked: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: companies.id });

  return created.id;
}

export async function toggleCompanyTracking(
  database: D1Database,
  companyId: number,
  tracked: number,
) {
  const now = Date.now();
  await database
    .prepare("UPDATE companies SET tracked = ?2, updated_at = ?3 WHERE id = ?1")
    .bind(companyId, tracked ? 1 : 0, now)
    .run();
}
