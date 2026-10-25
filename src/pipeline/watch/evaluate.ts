import { createModelClient, type ModelClient } from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import type { PipelineEnv } from "../messages";
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
}

interface ApprovedArticleRow {
  id: number;
  title: string;
  summary: string | null;
  body_sha: string;
  published_at: number | null;
  linked_at: number;
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
  // If keyword contains spaces or punctuation, substring search
  if (/[\s\-_]/.test(trimmed)) {
    return text.toLowerCase().includes(trimmed.toLowerCase());
  }
  // For single words / acronyms (like "AI"), use word boundary to avoid matching "chain"
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
      `SELECT id, title, revision, industry_id
       FROM events
       WHERE id = ?1`,
    )
    .bind(eventId)
    .first<EventRow>();

  if (!event || event.revision === 0) {
    return { eventId, eventRevision: 0, evaluatedCount: 0, hitCount: 0 };
  }

  // 2. Fetch approved articles for this event
  const { results: articles } = await db
    .prepare(
      `SELECT a.id, a.title, a.summary, a.body_sha, a.published_at, ea.created_at AS linked_at
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
       WHERE ea.event_id = ?1
       ORDER BY a.published_at ASC, a.id ASC`,
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

  // 3. Compute deterministic input SHA for cache / logical key
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

    // Rule 3: Keywords filter
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

    if (kwList.length > 0) {
      const fullText =
        event.title +
        " " +
        articles.map((a) => `${a.title} ${a.summary ?? ""}`).join(" ");

      const matched = kwList.some((k) => matchKeyword(fullText, k));
      if (!matched) {
        // Deterministic filter eliminated this combination: zero model cost!
        continue;
      }
    }

    evaluatedCount++;

    // Material contrast: newest 2 articles represent latest update
    const sortedByRecency = [...articles].sort(
      (a, b) => (b.published_at ?? 0) - (a.published_at ?? 0),
    );
    const newArticles = sortedByRecency.slice(0, 2);

    const judgeKey = `watch:judge:${watch.id}:${event.id}:${event.revision}:${inputSha.slice(0, 16)}:${WATCH_PROMPT_VERSION}`;

    const state = {
      title: event.title,
      summary: articles
        .map((a) => a.summary ?? "")
        .join(" ")
        .slice(0, 1500),
      body: articles
        .map((a) => `[Article] ${a.title}\n${a.summary ?? ""}`)
        .join("\n\n")
        .slice(0, 4000),
    };

    const questions = buildWatchJudgeQuestion(watch.question, watch.criteria);

    const answers = (await models.judge(judgeKey, state, questions)) as
      { progress?: { noul: number } } | undefined;

    const noulVal = answers?.progress?.noul ?? 0;
    const isHit = noulVal >= 1 ? noulVal >= 50 : noulVal >= 0.5;

    if (isHit) {
      hitCount++;
      const writeKey = `watch:summary:${watch.id}:${event.id}:${event.revision}:${inputSha.slice(0, 16)}:${WATCH_PROMPT_VERSION}`;
      const summaryReq = buildWatchSummaryPrompt(
        watch.question,
        watch.criteria,
        event.title,
        newArticles,
      );

      const summaryRes = await models.generateText(
        "write",
        writeKey,
        summaryReq,
      );
      const summaryText = summaryRes.text.trim().replace(/^["']|["']$/g, "");

      await db
        .prepare(
          `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
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
