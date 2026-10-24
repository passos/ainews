import { isEnabled } from "../../lib/flags";
import { dayBoundsUtc } from "../../lib/time";
import { CallInProgressError, createModelClient } from "../../providers/models";
import type { ModelTransport } from "../../providers/transport";
import type { DigestMessage, PipelineEnv } from "../messages";
import { sendDigestEmail, type DigestItemData } from "./email";
import {
  buildDigestRequest,
  DIGEST_PROMPT_VERSION,
  parseDigestOutput,
  type DigestPromptEvent,
} from "./prompt";

export interface DigestDeps {
  transport?: ModelTransport;
}

export const DEFAULT_MAX_ITEMS = 7;

interface EventRow {
  event_id: number;
  event_revision: number;
  event_created_at: number;
  title: string | null;
  summary: string | null;
  source_name: string | null;
  total_score: number | null;
  article_count: number;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildDailyDigest(
  env: PipelineEnv,
  msg: DigestMessage,
  now = Date.now(),
  deps: DigestDeps = {},
): Promise<void> {
  // 1. Load industry
  const industry = await env.DB.prepare(
    "SELECT id, slug, name, publish_mode, disclaimer FROM industries WHERE id = ?1",
  )
    .bind(msg.industryId)
    .first<{
      id: number;
      slug: string;
      name: string;
      publish_mode: "auto" | "review";
      disclaimer: string | null;
    }>();

  if (!industry) {
    console.error(`Industry ${msg.industryId} not found for digest`);
    return;
  }

  // If digest already exists, do not recompute. If not emailed, attempt emailing.
  const existing = await env.DB.prepare(
    "SELECT id, status, emailed_at FROM digests WHERE industry_id = ?1 AND kind = 'daily' AND period_start = ?2",
  )
    .bind(industry.id, msg.periodStart)
    .first<{ id: number; status: string; emailed_at: number | null }>();

  if (existing) {
    if (
      existing.status === "ready" &&
      existing.emailed_at === null &&
      isEnabled(env, "EMAIL_ENABLED")
    ) {
      await sendDigestEmail(env, existing.id, now);
    }
    return;
  }

  // 2. Read settings (timezone & max items)
  const settingsRows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('digest.timezone', 'digest.max_items')",
  ).all<{ key: string; value: string }>();

  const settingsMap = new Map(
    settingsRows.results.map((r) => [r.key, r.value]),
  );

  let tz = "UTC";
  const rawTz = settingsMap.get("digest.timezone");
  if (rawTz) {
    try {
      const parsed = JSON.parse(rawTz);
      tz = typeof parsed === "string" ? parsed : rawTz;
    } catch {
      tz = rawTz;
    }
  }

  let maxItems = DEFAULT_MAX_ITEMS;
  const rawMax = settingsMap.get("digest.max_items");
  if (rawMax) {
    try {
      const n = Number(JSON.parse(rawMax));
      if (Number.isInteger(n) && n >= 1 && n <= 15) {
        maxItems = n;
      }
    } catch {
      // Keep default
    }
  }

  // 3. Time bounds [startMs, endMs)
  const [startMs, endMs] = dayBoundsUtc(msg.periodStart, tz);

  // 4. Query candidate events
  const { results: eventRows } = await env.DB.prepare(
    `SELECT
      e.id AS event_id,
      e.revision AS event_revision,
      e.created_at AS event_created_at,
      (SELECT COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title)
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       LEFT JOIN analyses an ON an.id = (
         SELECT id FROM analyses WHERE article_id = a.id AND selected = 1 ORDER BY created_at DESC, id DESC LIMIT 1
       )
       WHERE ea.event_id = e.id
         AND EXISTS (
           SELECT 1 FROM reviews r
           WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
         )
       ORDER BY COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC
       LIMIT 1) AS title,

      (SELECT COALESCE(NULLIF(a.summary_override, ''), NULLIF(an.summary_en, ''), a.summary)
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       LEFT JOIN analyses an ON an.id = (
         SELECT id FROM analyses WHERE article_id = a.id AND selected = 1 ORDER BY created_at DESC, id DESC LIMIT 1
       )
       WHERE ea.event_id = e.id
         AND EXISTS (
           SELECT 1 FROM reviews r
           WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
         )
       ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
       LIMIT 1) AS summary,

      (SELECT COALESCE(NULLIF(s.name, ''), s.site_domain, 'Unknown source')
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       JOIN sources s ON s.id = a.source_id
       WHERE ea.event_id = e.id
         AND EXISTS (
           SELECT 1 FROM reviews r
           WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
         )
       ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
       LIMIT 1) AS source_name,

      (SELECT COALESCE(an.total_score, 0)
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       LEFT JOIN analyses an ON an.id = (
         SELECT id FROM analyses WHERE article_id = a.id AND selected = 1 ORDER BY created_at DESC, id DESC LIMIT 1
       )
       WHERE ea.event_id = e.id
         AND EXISTS (
           SELECT 1 FROM reviews r
           WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
         )
       ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
       LIMIT 1) AS total_score,

      (SELECT count(*)
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       WHERE ea.event_id = e.id
         AND EXISTS (
           SELECT 1 FROM reviews r
           WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
         )) AS article_count

    FROM events e
    WHERE e.industry_id = ?1
      AND EXISTS (
        SELECT 1 FROM event_articles ea
        JOIN articles a ON a.id = ea.article_id
        JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha
        WHERE ea.event_id = e.id
          AND r.decision = 'approved'
          AND r.created_at >= ?2 AND r.created_at < ?3
      )
      AND EXISTS (
        SELECT 1 FROM event_articles ea
        JOIN articles a ON a.id = ea.article_id
        JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha
        WHERE ea.event_id = e.id
          AND r.decision = 'approved'
      )
    ORDER BY total_score DESC, e.created_at DESC, e.id DESC
    LIMIT ?4`,
  )
    .bind(industry.id, startMs, endMs, maxItems)
    .all<EventRow>();

  // Filter out any anomaly where title is null
  const candidates: (DigestPromptEvent & { revision: number })[] = eventRows
    .filter((r) => Boolean(r.title))
    .map((r) => ({
      id: r.event_id,
      revision: r.event_revision,
      title: r.title!,
      summary: r.summary || "",
      sourceName: r.source_name || "Unknown source",
      score: r.total_score || 0,
      articleCount: r.article_count,
    }));

  // 5. If no candidates, record empty digest
  if (candidates.length === 0) {
    await env.DB.prepare(
      `INSERT INTO digests (
        industry_id, kind, period_start, timezone, status, intro, items_json,
        prompt_version, model, created_at, published_at, emailed_at
      ) VALUES (?1, 'daily', ?2, ?3, 'empty', '', '[]', NULL, NULL, ?4, NULL, NULL)
      ON CONFLICT (industry_id, kind, period_start) DO NOTHING`,
    )
      .bind(industry.id, msg.periodStart, tz, now)
      .run();
    return;
  }

  // 6. Synthesis via write slot (or deterministic fallback)
  let intro = "";
  const oneLiners = new Map<number, string>();
  let usedModel: string | null = null;
  const promptVersion = DIGEST_PROMPT_VERSION;

  const candidatePayload = JSON.stringify(
    candidates.map((c) => [
      c.id,
      c.revision,
      c.title,
      c.summary,
      c.sourceName,
      c.score,
      c.articleCount,
    ]),
  );
  const inputSha = (await sha256Hex(candidatePayload)).slice(0, 16);
  const logicalKey = `digest:${industry.id}:daily:${msg.periodStart}:${inputSha}:${DIGEST_PROMPT_VERSION}`;

  if (isEnabled(env, "MODEL_CALLS_ENABLED") && deps.transport) {
    try {
      const models = createModelClient({
        db: env.DB,
        transport: deps.transport,
        env,
      });
      const request = buildDigestRequest({
        industryName: industry.name,
        disclaimer: industry.disclaimer,
        periodStart: msg.periodStart,
        events: candidates,
      });

      const { text } = await models.generateText("write", logicalKey, request);

      const parsed = parseDigestOutput(text);
      if (parsed) {
        intro = parsed.intro;
        for (const item of parsed.items) {
          oneLiners.set(item.event_id, item.one_liner);
        }
      }
      usedModel = "write";
    } catch (err) {
      if (err instanceof CallInProgressError) {
        throw err;
      }
      console.error(
        "Digest model call failed, falling back to summaries:",
        err,
      );
    }
  }

  // Build items array
  const items: DigestItemData[] = candidates.map((c) => ({
    eventId: c.id,
    eventRevision: c.revision,
    title: c.title,
    oneLiner: oneLiners.get(c.id) || c.summary,
    sourceName: c.sourceName,
    articleCount: c.articleCount,
  }));

  // 7. Auto vs Review publishing
  const publishedAt = industry.publish_mode === "auto" ? now : null;

  await env.DB.prepare(
    `INSERT INTO digests (
      industry_id, kind, period_start, timezone, status, intro, items_json,
      prompt_version, model, created_at, published_at, emailed_at
    ) VALUES (?1, 'daily', ?2, ?3, 'ready', ?4, ?5, ?6, ?7, ?8, ?9, NULL)
    ON CONFLICT (industry_id, kind, period_start) DO NOTHING`,
  )
    .bind(
      industry.id,
      msg.periodStart,
      tz,
      intro,
      JSON.stringify(items),
      promptVersion,
      usedModel,
      now,
      publishedAt,
    )
    .run();

  // Read back row to get id for emailing (only if status is ready)
  const row = await env.DB.prepare(
    "SELECT id FROM digests WHERE industry_id = ?1 AND kind = 'daily' AND period_start = ?2 AND status = 'ready'",
  )
    .bind(industry.id, msg.periodStart)
    .first<{ id: number }>();

  if (row) {
    await sendDigestEmail(env, row.id, now);
  }
}
