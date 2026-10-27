// Public write entry "Ask about this story" and its answer read (#133).
// No model calls here: the question goes to Q_GENERATE and the existing Ask
// consumer (pipeline/ask/answer.ts) answers it. Never logs the question,
// token or hashes.
import { sql } from "drizzle-orm";
import { FINANCE_SLUG } from "../../lib/sections";
import { safeHttpUrl } from "../../lib/url";
import { getDb } from "../db/client";
import {
  APPROVED_ARTICLE_SQL,
  CARD_COLUMNS,
  CARD_FROM,
  approvedArticleWhere,
  publicSource,
  type CardRow,
} from "../publication/articles";
import {
  newReaderToken,
  READER_TOKEN_RE,
  tokenHash,
} from "../reader-watch/token";
import { ReaderAskError } from "./errors";
import type { AnswerInput, AskInput } from "./input";
import { READER_ASK_LIMITS } from "./limits";

/**
 * The Q_GENERATE message for a question. Same shape as AskMessage in
 * pipeline/messages.ts; R1 keeps public code out of pipeline/, so the test
 * pins the two together.
 */
export type AskQueueMessage = { kind: "ask"; questionId: number };

export interface AskContext {
  method: string;
  enabled: boolean;
  now: number;
  queue: { send(message: AskQueueMessage): Promise<unknown> };
}

const DAY_MS = 86_400_000;

// The event exists and has at least one approved article.
const PUBLIC_EVENT = `SELECT i.slug AS slug
  FROM events e
  JOIN industries i ON i.id = e.industry_id
  WHERE e.id = ?1 AND EXISTS (
    SELECT 1 FROM event_articles ea
    JOIN articles a ON a.id = ea.article_id
    WHERE ea.event_id = e.id AND ${APPROVED_ARTICLE_SQL}
  )`;

// One statement: the daily cap check and the insert are atomic in D1.
// prompt_version and model are NOT NULL; the Ask consumer overwrites them,
// as for admin questions (server/admin/ops.ts createQuestion).
const INSERT_PUBLIC_QUESTION = `INSERT INTO questions
  (question, scope_type, event_id, status, prompt_version, model,
   created_at, origin, public_token_hash)
  SELECT ?1, 'event', ?2, 'pending', 'ask:v1', 'default', ?3, 'public', ?4
  WHERE (SELECT count(*) FROM questions
         WHERE origin = 'public' AND created_at >= ?5 AND created_at < ?6) < ?7`;

export async function askAboutStoryCore(
  db: D1Database,
  input: AskInput,
  ctx: AskContext,
): Promise<{ questionId: number; token: string }> {
  if (ctx.method !== "POST") {
    throw new ReaderAskError("method_not_allowed", 405);
  }
  if (!ctx.enabled) throw new ReaderAskError("ask_disabled", 403);

  const event = await db
    .prepare(PUBLIC_EVENT)
    .bind(input.eventId)
    .first<{ slug: string }>();
  if (!event) throw new ReaderAskError("not_found", 404);
  if (event.slug.trim().toLowerCase() === FINANCE_SLUG) {
    throw new ReaderAskError("section_not_allowed", 403);
  }

  const dayStart = Math.floor(ctx.now / DAY_MS) * DAY_MS;
  const token = newReaderToken();
  const result = await db
    .prepare(INSERT_PUBLIC_QUESTION)
    .bind(
      input.question,
      input.eventId,
      ctx.now,
      await tokenHash(token),
      dayStart,
      dayStart + DAY_MS,
      READER_ASK_LIMITS.publicPerDay,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new ReaderAskError("daily_limit", 429);
  }

  const questionId = Number(result.meta.last_row_id);
  await ctx.queue.send({ kind: "ask", questionId });
  return { questionId, token };
}

export interface StoryCitation {
  quote: string;
  claim: string;
  title: string;
  sourceName: string;
  /** The article's own link; null unless http(s). */
  url: string | null;
  /** The article page on this site. */
  href: string;
}

export interface StoryAnswer {
  status: "pending" | "processing" | "completed" | "failed";
  refusal: boolean;
  /** The model's answer; null until completed, and for a refusal. */
  answer: string | null;
  citations: StoryCitation[];
  unverified: string[];
}

interface QuestionRow {
  status: StoryAnswer["status"];
  refusal: number;
  answer: string | null;
  citations: string | null;
  unverified: string | null;
  event_id: number | null;
}

interface StoredCitation {
  articleId: number;
  quote: string;
  claim: string;
}

function parseJsonArray(text: string | null): unknown[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// Only citations the Ask consumer verified verbatim.
function verifiedCitations(text: string | null): StoredCitation[] {
  return parseJsonArray(text).flatMap((c) => {
    if (typeof c !== "object" || c === null) return [];
    const r = c as Record<string, unknown>;
    if (r.verified !== true) return [];
    if (!Number.isInteger(r.articleId)) return [];
    if (typeof r.quote !== "string" || typeof r.claim !== "string") return [];
    return [
      { articleId: r.articleId as number, quote: r.quote, claim: r.claim },
    ];
  });
}

// Approved articles of the question's event. A citation of any other
// article (not approved, another event, a supplemental page) is dropped.
async function citedArticles(
  db: D1Database,
  eventId: number,
  ids: number[],
): Promise<Map<number, CardRow>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb(db).all<CardRow>(sql`
    SELECT ${CARD_COLUMNS}
    ${CARD_FROM}
    WHERE a.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND ea.event_id = ${eventId}
      AND ${approvedArticleWhere}`);
  return new Map(rows.map((r) => [Number(r.id), r]));
}

export async function getStoryAnswerCore(
  db: D1Database,
  input: AnswerInput,
  ctx: { method: string },
): Promise<StoryAnswer> {
  if (ctx.method !== "POST") {
    throw new ReaderAskError("method_not_allowed", 405);
  }
  if (!READER_TOKEN_RE.test(input.token)) {
    throw new ReaderAskError("not_found", 404);
  }
  const row = await db
    .prepare(
      `SELECT status, refusal, answer, citations, unverified, event_id
       FROM questions
       WHERE id = ?1 AND origin = 'public' AND public_token_hash = ?2`,
    )
    .bind(input.questionId, await tokenHash(input.token))
    .first<QuestionRow>();
  if (!row) throw new ReaderAskError("not_found", 404);

  if (row.status !== "completed") {
    return {
      status: row.status,
      refusal: false,
      answer: null,
      citations: [],
      unverified: [],
    };
  }

  const refusal = row.refusal === 1;
  const stored = refusal ? [] : verifiedCitations(row.citations);
  const articles =
    row.event_id === null
      ? new Map<number, CardRow>()
      : await citedArticles(db, row.event_id, [
          ...new Set(stored.map((c) => c.articleId)),
        ]);
  const citations = stored.flatMap((c): StoryCitation[] => {
    const a = articles.get(c.articleId);
    if (!a) return [];
    return [
      {
        quote: c.quote,
        claim: c.claim,
        title: a.title,
        sourceName: publicSource(a).name,
        url: safeHttpUrl(a.url),
        href: `/a/${c.articleId}`,
      },
    ];
  });

  return {
    status: "completed",
    refusal,
    answer: refusal ? null : row.answer,
    citations,
    unverified: parseJsonArray(row.unverified).filter(
      (u): u is string => typeof u === "string",
    ),
  };
}
