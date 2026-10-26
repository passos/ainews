import { createModelClient, type ModelClient } from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import type { PipelineEnv } from "../messages";
import { APPROVED_ARTICLE_SQL } from "../../server/publication/articles";
import {
  WATCH_PROMPT_VERSION,
  buildWatchJudgeQuestion,
  buildWatchSummaryPrompt,
} from "./prompts";

export interface WatchDeps {
  db?: D1Database;
  models?: ModelClient;
  transport?: ModelTransport;
  now?: () => number;
}

export interface WatchEvaluationResult {
  eventId: number;
  eventRevision: number;
  evaluatedCount: number;
  hitCount: number;
}

interface EventRow {
  id: number;
  title: string;
  revision: number;
  industry_id: number;
  updated_at: number;
}

interface ApprovedArticleRow {
  id: number;
  title: string;
  summary: string | null;
  body_sha: string;
  published_at: number | null;
  effective_at: number;
}

interface WatchRow {
  id: number;
  slug: string;
  question: string;
  criteria: string;
  keywords: string;
  industry_id: number | null;
  status: "active" | "paused";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function matchKeyword(text: string, keyword: string): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return false;
  // If keyword contains non-word characters (C#, .NET, $TSLA, spaces, hyphens)
  // or non-ASCII characters (e.g. Chinese), use substring search
  if (!/^\w+$/.test(trimmed) || /[\u0080-\uFFFF]/.test(trimmed)) {
    return text.toLowerCase().includes(trimmed.toLowerCase());
  }
  // Pure ASCII single word / acronym (e.g. "AI", "GPT"): word boundary regex to prevent "chain" matching "ai"
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "i");
  return regex.test(text);
}

export async function evaluateEventWatches(
  env: Pick<PipelineEnv, "DB" | "AI" | "AI_GATEWAY_ID" | "MODEL_CALLS_ENABLED">,
  eventId: number,
  nowMs = Date.now(),
  deps: WatchDeps = {},
): Promise<WatchEvaluationResult> {
  const db = deps.db ?? env.DB;
  if (!db) {
    return { eventId, eventRevision: 0, evaluatedCount: 0, hitCount: 0 };
  }

  const models =
    deps.models ??
    createModelClient({
      db,
      transport:
        deps.transport ??
        (env.AI
          ? bindingTransport(env.AI, env.AI_GATEWAY_ID ?? "ainews")
          : { run: () => Promise.reject(new Error("no AI binding")) }),
      env: {
        MODEL_CALLS_ENABLED: env.MODEL_CALLS_ENABLED ?? "false",
      },
      now: deps.now,
    });

  // 1. Fetch event
  const event = await db
    .prepare(
      `SELECT id, title, revision, industry_id, updated_at
       FROM events
       WHERE id = ?1`,
    )
    .bind(eventId)
    .first<EventRow>();

  if (!event || event.revision === 0) {
    return { eventId, eventRevision: 0, evaluatedCount: 0, hitCount: 0 };
  }

  // 2. Fetch approved articles for this event (APPROVED_ARTICLE_SQL)
  // An article becomes an approved member of this event when BOTH linked (ea.created_at)
  // and approved (r.created_at). Its effective timestamp is MAX(ea.created_at, r.created_at).
  const { results: articles } = await db
    .prepare(
      `SELECT a.id, a.title, a.summary, a.body_sha, a.published_at,
              MAX(ea.created_at, r.created_at) AS effective_at
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha
       WHERE ea.event_id = ?1 AND ${APPROVED_ARTICLE_SQL}
       ORDER BY MAX(ea.created_at, r.created_at) ASC, a.id ASC`,
    )
    .bind(eventId)
    .all<ApprovedArticleRow>();

  if (!articles || articles.length === 0) {
    return {
      eventId,
      eventRevision: event.revision,
      evaluatedCount: 0,
      hitCount: 0,
    };
  }

  // If revision > 1, verify if this revision bump was from a newly joined/approved article.
  // When an article is approved or grouped, event.updated_at matches effective_at.
  // If an article was retracted, no remaining article has effective_at == updated_at.
  const maxEffectiveAt = Math.max(...articles.map((a) => a.effective_at));
  const isRetractionRevision =
    event.revision > 1 && maxEffectiveAt < event.updated_at;

  if (isRetractionRevision) {
    // Retraction of an article cannot constitute a new material development
    return {
      eventId,
      eventRevision: event.revision,
      evaluatedCount: 0,
      hitCount: 0,
    };
  }

  // Event title derived from approved articles to prevent unverified titles leaking
  const derivedTitle = articles[articles.length - 1]?.title || event.title;

  // 3. Compute deterministic input SHA
  const inputSha = await sha256Hex(
    articles
      .map((a) => `${a.id}:${a.body_sha}`)
      .sort()
      .join(","),
  );

  // 4. Fetch active watches
  const { results: activeWatches } = await db
    .prepare(
      `SELECT id, slug, question, criteria, keywords, industry_id, status
       FROM watches
       WHERE status = 'active'`,
    )
    .all<WatchRow>();

  if (!activeWatches || activeWatches.length === 0) {
    return {
      eventId,
      eventRevision: event.revision,
      evaluatedCount: 0,
      hitCount: 0,
    };
  }

  let evaluatedCount = 0;
  let hitCount = 0;

  for (const watch of activeWatches) {
    // Rule 1: Scope filter
    if (watch.industry_id !== null && watch.industry_id !== event.industry_id) {
      continue;
    }

    // Rule 2: Idempotency check - skip if already hit for this revision
    const alreadyHit = await db
      .prepare(
        `SELECT 1 FROM watch_hits
         WHERE watch_id = ?1 AND event_id = ?2 AND event_revision = ?3`,
      )
      .bind(watch.id, event.id, event.revision)
      .first();

    if (alreadyHit) {
      continue;
    }

    // Rule 3: Keywords filter (Must have at least one matching keyword; empty keywords are filtered out)
    let kwList: string[] = [];
    try {
      const parsed = JSON.parse(watch.keywords);
      if (Array.isArray(parsed)) {
        kwList = parsed.filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0,
        );
      }
    } catch {
      kwList = watch.keywords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // A watch with no keywords never bypasses filtering to invoke models
    if (kwList.length === 0) {
      continue;
    }

    const fullText =
      derivedTitle +
      " " +
      articles.map((a) => `${a.title} ${a.summary ?? ""}`).join(" ");

    const matched = kwList.some((k) => matchKeyword(fullText, k));
    if (!matched) {
      // Deterministic filter eliminated this combination: zero model cost!
      continue;
    }

    evaluatedCount++;

    // Partition articles into new reporting (this revision) vs prior reporting
    let newArticles: ApprovedArticleRow[];
    let priorArticles: ApprovedArticleRow[];

    if (event.revision === 1) {
      if (articles.length > 2) {
        newArticles = articles.slice(-2);
        priorArticles = articles.slice(0, -2);
      } else {
        newArticles = articles;
        priorArticles = [];
      }
    } else {
      newArticles = articles.filter((a) => a.effective_at === maxEffectiveAt);
      priorArticles = articles.filter((a) => a.effective_at < maxEffectiveAt);
      if (newArticles.length === 0) {
        newArticles = [articles[articles.length - 1]];
        priorArticles = articles.slice(0, -1);
      }
    }

    const watchSha = (
      await sha256Hex(`${watch.question}:${watch.criteria}`)
    ).slice(0, 8);

    // Ledger keys bound to watch configuration hash and content input SHA
    const judgeKey = `watch:judge:${watch.id}:${event.id}:${event.revision}:${inputSha.slice(0, 16)}:${watchSha}:${WATCH_PROMPT_VERSION}`;

    const newReportingText = newArticles
      .map((a) => `[New Article] ${a.title}\n${a.summary ?? ""}`)
      .join("\n\n")
      .slice(0, 2000);

    const bodySections: string[] = [
      "=== NEW REPORTING IN THIS UPDATE ===",
      newReportingText,
    ];

    if (priorArticles.length > 0) {
      const priorReportingText = priorArticles
        .map((a) => `[Prior Article] ${a.title}\n${a.summary ?? ""}`)
        .join("\n\n")
        .slice(0, 2000);

      bodySections.push(
        "=== PRIOR REPORTING (ALREADY KNOWN) ===",
        priorReportingText,
      );
    }

    const state = {
      title: derivedTitle,
      summary: newArticles
        .map((a) => a.summary ?? "")
        .join(" ")
        .slice(0, 1000),
      body: bodySections.join("\n\n"),
    };

    const questions = buildWatchJudgeQuestion(watch.question, watch.criteria);

    const answers = (await models.judge(judgeKey, state, questions)) as
      { progress?: { noul: number } } | undefined;

    const noulVal = answers?.progress?.noul ?? 0;
    // Strict > 1 for percentage scale, otherwise >= 0.5 (so noul = 1.0 is a hit)
    const isHit = noulVal > 1 ? noulVal >= 50 : noulVal >= 0.5;

    if (isHit) {
      hitCount++;
      const writeKey = `watch:summary:${watch.id}:${event.id}:${event.revision}:${inputSha.slice(0, 16)}:${watchSha}:${WATCH_PROMPT_VERSION}`;
      const summaryReq = buildWatchSummaryPrompt(
        watch.question,
        watch.criteria,
        derivedTitle,
        newArticles,
      );

      const summaryRes = await models.generateText(
        "write",
        writeKey,
        summaryReq,
      );

      let summaryText = summaryRes.text.trim().replace(/^["']|["']$/g, "");

      // Guard: Discard partial output on non-STOP finishReason and fallback cleanly
      if (summaryRes.finishReason !== "STOP") {
        console.warn({
          watchId: watch.id,
          eventId: event.id,
          warning: `Watch summary generation truncated (${summaryRes.finishReason}); discarding partial text and using fallback`,
        });
        summaryText =
          newArticles[0]?.title ||
          "Material development confirmed by evaluation.";
      }

      // Atomic insertion: only commit if event revision hasn't changed concurrently
      await db
        .prepare(
          `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE (SELECT revision FROM events WHERE id = ?2) = ?3
           ON CONFLICT (watch_id, event_id, event_revision) DO NOTHING`,
        )
        .bind(
          watch.id,
          event.id,
          event.revision,
          nowMs,
          summaryText || "Material development confirmed by evaluation.",
          JSON.stringify({
            noul: noulVal,
            promptVersion: WATCH_PROMPT_VERSION,
            articleIds: newArticles.map((a) => a.id),
          }),
        )
        .run();
    }
  }

  return {
    eventId,
    eventRevision: event.revision,
    evaluatedCount,
    hitCount,
  };
}
