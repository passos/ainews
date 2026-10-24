import { sql } from "drizzle-orm";
import { utcDay } from "../../providers/budget";
import { getDb } from "../db/client";
import {
  analyses,
  articles,
  budgets,
  corrections,
  dlqMessages,
  industries,
  llmCalls,
  reviews,
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
      failCount: sources.failCount,
      emptyFetches: sources.emptyFetches,
      lastOkAt: sources.lastOkAt,
      lastFailedAt: sources.lastFailedAt,
      lastError: sources.lastError,
      jinaEnabled: sources.jinaEnabled,
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
  },
) {
  const d = getDb(database);
  const res = await d
    .insert(sources)
    .values({
      industryId: data.industryId,
      name: data.name,
      feedUrl: data.feedUrl,
      siteDomain: data.siteDomain ?? null,
      kind: data.kind,
      intervalMinutes: data.intervalMinutes ?? 60,
      utcOffset: data.utcOffset ?? "+00:00",
      config: data.config ?? "{}",
      jinaEnabled: data.jinaEnabled ?? 0,
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
  },
) {
  await database
    .prepare(
      `UPDATE sources
       SET name = ?1, feed_url = ?2, site_domain = ?3, interval_minutes = COALESCE(?4, interval_minutes),
           utc_offset = COALESCE(?5, utc_offset), config = COALESCE(?6, config), jina_enabled = COALESCE(?7, jina_enabled)
       WHERE id = ?8`,
    )
    .bind(
      data.name,
      data.feedUrl,
      data.siteDomain ?? null,
      data.intervalMinutes ?? null,
      data.utcOffset ?? null,
      data.config ?? null,
      data.jinaEnabled ?? null,
      data.id,
    )
    .run();
}

export async function deleteSource(database: D1Database, id: number) {
  await database.prepare("DELETE FROM sources WHERE id = ?1").bind(id).run();
}

export async function resumeSource(database: D1Database, id: number) {
  await database
    .prepare(
      `UPDATE sources
       SET status = 'active', fail_count = 0, empty_fetches = 0, paused_reason = NULL
       WHERE id = ?1`,
    )
    .bind(id)
    .run();
}

export async function triggerCollect(
  qIngest: { send: (msg: unknown) => Promise<unknown> },
  sourceId: number,
) {
  await qIngest.send({ kind: "collect", sourceId });
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
    WHERE a.stage = 'analyzed'
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
  await database
    .prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (article_id, body_sha)
       DO UPDATE SET decision = excluded.decision, reviewer = excluded.reviewer, created_at = excluded.created_at`,
    )
    .bind(data.articleId, data.bodySha, data.decision, data.reviewer, now)
    .run();
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
    .orderBy(sql`${analyses.createdAt} DESC`);

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

  await database
    .prepare(
      "UPDATE articles SET title_override = ?1, summary_override = ?2 WHERE id = ?3",
    )
    .bind(title, summary, data.articleId)
    .run();
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

export async function reanalyzeArticle(
  database: D1Database,
  qIngest: { send: (msg: unknown) => Promise<unknown> },
  articleId: number,
) {
  const now = Date.now();
  await database.batch([
    database
      .prepare("DELETE FROM analyses WHERE article_id = ?1")
      .bind(articleId),
    database
      .prepare(
        "UPDATE articles SET stage = 'body_ready', requeue_count = 0, stage_updated_at = ?1 WHERE id = ?2",
      )
      .bind(now, articleId),
    database
      .prepare(
        "DELETE FROM llm_calls WHERE logical_key LIKE 'analyze:' || ?1 || ':%' OR logical_key LIKE 'write:' || ?1 || ':%'",
      )
      .bind(articleId),
  ]);

  await qIngest.send({ kind: "analyze", articleId });
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
