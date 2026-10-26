import {
  CallFailedError,
  createModelClient,
  type ModelClient,
} from "../../providers/models";
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
  watch_evaluated_revision: number;
  watch_evaluated_through: number | null;
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
  created_at: number;
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

/** Article ids that a stored hit cites; unreadable rationale cites none. */
function citedIds(rationale: string): number[] {
  try {
    const ids = (JSON.parse(rationale) as { articleIds?: unknown }).articleIds;
    return Array.isArray(ids)
      ? ids.filter((id): id is number => typeof id === "number")
      : [];
  } catch {
    return [];
  }
}

/**
 * Every hit starts in the review queue, auto sections and Finance alike: its
 * summary and rationale are model-written text (#85 ruling 1, N§6).
 */
export function watchHitInitialStatus(): "pending_review" {
  return "pending_review";
}

/**
 * Records that `revision` of the event finished its watch evaluation. The
 * marker only moves forward. `through` is the new boundary of known
 * reporting; null keeps the old one. Neither `updated_at` nor `revision`
 * changes: both are inputs of scheduling and retraction checks.
 */
export async function markWatchEvaluated(
  db: D1Database,
  eventId: number,
  revision: number,
  through: number | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE events
       SET watch_evaluated_revision = ?2,
           watch_evaluated_through = COALESCE(?3, watch_evaluated_through)
       WHERE id = ?1 AND watch_evaluated_revision < ?2`,
    )
    .bind(eventId, revision, through)
    .run();
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
      `SELECT e.id, e.title, e.revision, e.industry_id, e.updated_at,
              e.watch_evaluated_revision, e.watch_evaluated_through
       FROM events e
       WHERE e.id = ?1`,
    )
    .bind(eventId)
    .first<EventRow>();

  if (!event || event.revision === 0) {
    return { eventId, eventRevision: 0, evaluatedCount: 0, hitCount: 0 };
  }

  // This revision was already evaluated: no model call, no write.
  if (event.watch_evaluated_revision >= event.revision) {
    return {
      eventId,
      eventRevision: event.revision,
      evaluatedCount: 0,
      hitCount: 0,
    };
  }

  // Every return below that is a settled outcome marks the revision.
  // Retryable errors propagate and leave the marker where it is.
  const markEvaluated = (through: number | null) =>
    markWatchEvaluated(db, event.id, event.revision, through);

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
    await markEvaluated(null);
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

  // Find the new reporting. It does not depend on the watch, so it is
  // computed once; each watch then drops what it already knows (Rule 2).
  let newArticles: ApprovedArticleRow[];
  const through = event.watch_evaluated_through;

  if (through !== null) {
    // Everything approved after the last evaluation is new, however many
    // revisions were skipped in between.
    // Strict >: an approval in the same millisecond as the boundary is missed; >= would re-judge (and pay for) the boundary article.
    newArticles = articles.filter((a) => a.effective_at > through);
    if (newArticles.length === 0) {
      // No new reporting (e.g. an article left the event). Keep the old
      // boundary: here maxEffectiveAt <= through.
      await markEvaluated(null);
      return {
        eventId,
        eventRevision: event.revision,
        evaluatedCount: 0,
        hitCount: 0,
      };
    }
  } else {
    // First evaluation of this event.
    const isRetractionRevision =
      event.revision > 1 && maxEffectiveAt < event.updated_at;

    if (isRetractionRevision) {
      // Retraction of an article cannot constitute a new material development
      await markEvaluated(maxEffectiveAt);
      return {
        eventId,
        eventRevision: event.revision,
        evaluatedCount: 0,
        hitCount: 0,
      };
    }

    if (event.revision === 1) {
      if (articles.length > 2) {
        newArticles = articles.slice(-2);
      } else {
        newArticles = articles;
      }
    } else {
      newArticles = articles.filter((a) => a.effective_at === maxEffectiveAt);
      if (newArticles.length === 0) {
        newArticles = [articles[articles.length - 1]];
      }
    }
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
      `SELECT id, slug, question, criteria, keywords, industry_id, status, created_at
       FROM watches
       WHERE status = 'active'`,
    )
    .all<WatchRow>();

  if (!activeWatches || activeWatches.length === 0) {
    await markEvaluated(maxEffectiveAt);
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

    // Rule 2: New reporting for this watch. An article that an earlier hit
    // of this watch already cited (at any revision, any status) is prior
    // reporting; so is an article approved before the watch existed
    // (invariant 9). Nothing new left: no model call.
    const { results: priorHits } = await db
      .prepare(
        `SELECT rationale FROM watch_hits WHERE watch_id = ?1 AND event_id = ?2`,
      )
      .bind(watch.id, event.id)
      .all<{ rationale: string }>();
    const hitArticleIds = new Set(
      priorHits.flatMap((h) => citedIds(h.rationale)),
    );
    const watchNew = newArticles.filter(
      (a) => a.effective_at > watch.created_at && !hitArticleIds.has(a.id),
    );
    if (watchNew.length === 0) {
      continue;
    }
    const watchPrior = articles.filter((a) => !watchNew.includes(a));

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

    const watchSha = (
      await sha256Hex(`${watch.question}:${watch.criteria}`)
    ).slice(0, 8);

    // watchNew depends on the hit history and watch.created_at, so it is an
    // input of the judge and write calls and belongs in their ledger keys.
    const newSha = (
      await sha256Hex(
        watchNew
          .map((a) => `${a.id}:${a.body_sha}`)
          .sort()
          .join(","),
      )
    ).slice(0, 16);

    // Ledger keys bound to watch configuration hash and content input SHA
    const judgeKey = `watch:judge:${watch.id}:${event.id}:${event.revision}:${inputSha.slice(0, 16)}:${watchSha}:${WATCH_PROMPT_VERSION}:${newSha}`;

    const newReportingText = watchNew
      .map((a) => `[New Article] ${a.title}\n${a.summary ?? ""}`)
      .join("\n\n")
      .slice(0, 2000);

    const bodySections: string[] = [
      "=== NEW REPORTING IN THIS UPDATE ===",
      newReportingText,
    ];

    if (watchPrior.length > 0) {
      const priorReportingText = watchPrior
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
      summary: watchNew
        .map((a) => a.summary ?? "")
        .join(" ")
        .slice(0, 1000),
      body: bodySections.join("\n\n"),
    };

    const questions = buildWatchJudgeQuestion(watch.question, watch.criteria);

    let answers: { progress?: { noul: number } } | undefined;
    try {
      answers = (await models.judge(judgeKey, state, questions)) as
        { progress?: { noul: number } } | undefined;
    } catch (e) {
      // Out of attempts is a settled outcome for this watch only. Every
      // other error is retryable and leaves the revision unmarked.
      if (!(e instanceof CallFailedError)) throw e;
      console.error({ watchId: watch.id, eventId: event.id, error: e.message });
      continue;
    }

    const noulVal = answers?.progress?.noul ?? 0;
    // Strict > 1 for percentage scale, otherwise >= 0.5 (so noul = 1.0 is a hit)
    const isHit = noulVal > 1 ? noulVal >= 50 : noulVal >= 0.5;

    if (isHit) {
      hitCount++;
      const writeKey = `watch:summary:${watch.id}:${event.id}:${event.revision}:${inputSha.slice(0, 16)}:${watchSha}:${WATCH_PROMPT_VERSION}:${newSha}`;
      const summaryReq = buildWatchSummaryPrompt(
        watch.question,
        watch.criteria,
        derivedTitle,
        watchNew,
      );

      let summaryText: string;
      try {
        const summaryRes = await models.generateText(
          "write",
          writeKey,
          summaryReq,
        );

        summaryText = summaryRes.text.trim().replace(/^["']|["']$/g, "");

        // Guard: Discard partial output on non-STOP finishReason and fallback cleanly
        if (summaryRes.finishReason !== "STOP") {
          console.warn({
            watchId: watch.id,
            eventId: event.id,
            warning: `Watch summary generation truncated (${summaryRes.finishReason}); discarding partial text and using fallback`,
          });
          summaryText =
            watchNew[0]?.title ||
            "Material development confirmed by evaluation.";
        }
      } catch (e) {
        // Out of attempts: record the hit with the fallback summary.
        if (!(e instanceof CallFailedError)) throw e;
        console.error({
          watchId: watch.id,
          eventId: event.id,
          error: e.message,
        });
        summaryText =
          watchNew[0]?.title || "Material development confirmed by evaluation.";
      }

      // No revision condition: the hit records a development at this
      // revision and does not expire when the event moves on (invariant 3).
      // A later retraction is hidden by the public article guard.
      await db
        .prepare(
          `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale, status)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
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
            articleIds: watchNew.map((a) => a.id),
          }),
          watchHitInitialStatus(),
        )
        .run();
    }
  }

  await markEvaluated(maxEffectiveAt);

  return {
    eventId,
    eventRevision: event.revision,
    evaluatedCount,
    hitCount,
  };
}
