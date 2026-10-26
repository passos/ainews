import type { PipelineEnv } from "../messages";
import { checkRobots, claimHostSlot, hostAllowed } from "../body/robots";
import {
  fetchPage,
  MAX_BODY_BYTES,
  type LadderDeps,
  type ToMarkdown,
} from "../body/ladder";
import { extractWhitelistedUrls } from "./verify";
import { syncRevisionDiff } from "./diff";
import { normalizeUrl } from "../../lib/url";
import { isEnabled } from "../../lib/flags";
import { effectivePublishMode } from "../analyze/analyze";
import { toMarkdown } from "../../providers/tomarkdown";

export interface PrimaryTrackerDeps {
  db: D1Database;
  bodies?: R2Bucket;
  fetch?: typeof fetch;
  toMarkdown?: ToMarkdown;
  now?: () => number;
  qArtifacts?: { send: (msg: unknown) => Promise<unknown> };
  qEvidence?: { send: (msg: unknown) => Promise<unknown> };
}

interface EventRow {
  id: number;
  industry_id: number;
  industry_slug: string;
  industry_publish_mode: "auto" | "review";
  revision: number;
  primary_domains: string;
}

interface ApprovedArticleRow {
  id: number;
  body_sha: string;
  canonical_url: string;
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

/** Feed URL of the per-section placeholder source for primary documents. */
const PRIMARY_DOCUMENTS_FEED_URL = "system:primary-documents";

/**
 * The section's existing source whose `site_domain` covers `host`, or null.
 * Candidates are not admin-approved, so they never count.
 */
async function findAttributionSourceId(
  db: D1Database,
  industryId: number,
  host: string,
): Promise<number | null> {
  const { results } = await db
    .prepare(
      `SELECT id, site_domain FROM sources
       WHERE industry_id = ?1 AND status IN ('active', 'paused')
         AND site_domain IS NOT NULL AND site_domain != ''
       ORDER BY id ASC`,
    )
    .bind(industryId)
    .all<{ id: number; site_domain: string }>();
  const row = results.find((r) => hostAllowed(host, [r.site_domain]));
  return row ? row.id : null;
}

/**
 * The section's placeholder source for primary documents, created on first
 * use. It is 'paused' with no site_domain, so collection never claims it and
 * it never widens a domain allowlist. DO NOTHING keeps admin edits.
 */
async function ensurePrimaryDocumentsSource(
  db: D1Database,
  industryId: number,
  now: number,
): Promise<number> {
  const [, select] = await db.batch<{ id: number }>([
    db
      .prepare(
        `INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at)
         VALUES (?1, 'Primary documents (system)', ?2, 'html', 'paused', ?3)
         ON CONFLICT (industry_id, feed_url) DO NOTHING`,
      )
      .bind(industryId, PRIMARY_DOCUMENTS_FEED_URL, now),
    db
      .prepare(
        `SELECT id FROM sources WHERE industry_id = ?1 AND feed_url = ?2`,
      )
      .bind(industryId, PRIMARY_DOCUMENTS_FEED_URL),
  ]);
  return select.results[0].id;
}

function truncateUtf8Bytes(str: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(str);
  if (bytes.byteLength <= maxBytes) return str;
  let end = maxBytes;
  if ((bytes[end] & 0xc0) === 0x80) {
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
  }
  return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
}

/**
 * Tracks primary sources linked in approved articles for an event (N§2.2, N§2.5).
 * Only fetches links pointing to whitelisted domains in `industries.primary_domains`.
 */
export async function trackEventPrimarySources(
  deps: PrimaryTrackerDeps,
  env: Pick<PipelineEnv, "DB" | "BODIES">,
  eventId: number,
  primaryDomains: string[] = [],
  now = deps.now ? deps.now() : Date.now(),
): Promise<{ trackedCount: number }> {
  // 1. Fetch event and industry primary domains
  const event = await deps.db
    .prepare(
      `SELECT e.id, e.industry_id, e.revision, i.slug AS industry_slug, i.publish_mode AS industry_publish_mode, i.primary_domains
       FROM events e
       JOIN industries i ON i.id = e.industry_id
       WHERE e.id = ?1`,
    )
    .bind(eventId)
    .first<EventRow>();

  if (!event) {
    return { trackedCount: 0 };
  }

  // Only an auto section gets system approval; Finance never does.
  const autoApprove =
    effectivePublishMode({
      slug: event.industry_slug,
      publish_mode: event.industry_publish_mode,
    }) === "auto";

  let effectivePrimaryDomains = primaryDomains;
  if (effectivePrimaryDomains.length === 0 && event.primary_domains) {
    try {
      effectivePrimaryDomains = JSON.parse(event.primary_domains);
    } catch {
      effectivePrimaryDomains = [];
    }
  }

  if (effectivePrimaryDomains.length === 0) {
    // Record scan so it yields to other events if ever invoked
    await deps.db
      .prepare(
        `INSERT INTO event_artifacts (
           event_id, type, audience, input_revision, prompt_version, model, content, status, created_at
         )
         VALUES (?1, 'primary_tracked', '', ?2, 'v1', 'tracker', '{}', 'published', ?3)
         ON CONFLICT (event_id, type, audience, input_revision, prompt_version, model)
         DO UPDATE SET created_at = excluded.created_at`,
      )
      .bind(eventId, event.revision, now)
      .run();
    return { trackedCount: 0 };
  }

  // 2. Fetch approved articles for the event
  const { results: articles } = await deps.db
    .prepare(
      `SELECT a.id, a.body_sha, a.canonical_url
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
       WHERE ea.event_id = ?1
       ORDER BY a.id ASC`,
    )
    .bind(eventId)
    .all<ApprovedArticleRow>();

  if (articles.length === 0) {
    return { trackedCount: 0 };
  }

  // 3. Extract candidate whitelisted URLs from article bodies
  const candidateUrls: string[] = [];
  const seenCandidates = new Set<string>();

  for (const art of articles) {
    let bodyText = "";
    if (deps.bodies) {
      const obj = await deps.bodies.get(`bodies/${art.id}/${art.body_sha}.md`);
      if (obj) {
        bodyText = await obj.text();
      }
    }

    if (!bodyText) continue;

    const urls = extractWhitelistedUrls(bodyText, effectivePrimaryDomains);
    for (const u of urls) {
      const norm = normalizeUrl(u) ?? u;
      if (!seenCandidates.has(norm)) {
        seenCandidates.add(norm);
        candidateUrls.push(u);
      }
    }
  }

  // Record that this event was scanned for primary sources (LRU rotation for trackDuePrimarySources)
  await deps.db
    .prepare(
      `INSERT INTO event_artifacts (
         event_id, type, audience, input_revision, prompt_version, model, content, status, created_at
       )
       VALUES (?1, 'primary_tracked', '', ?2, 'v1', 'tracker', '{}', 'published', ?3)
       ON CONFLICT (event_id, type, audience, input_revision, prompt_version, model)
       DO UPDATE SET created_at = excluded.created_at`,
    )
    .bind(eventId, event.revision, now)
    .run();

  if (candidateUrls.length === 0) {
    return { trackedCount: 0 };
  }

  const fetchFn = deps.fetch ?? fetch;
  const ai =
    "AI" in env && (env as PipelineEnv).AI ? (env as PipelineEnv).AI : null;
  const toMarkdownFn: ToMarkdown =
    deps.toMarkdown ??
    (ai
      ? (bytes, mime, baseUrl) => toMarkdown(ai, bytes, mime, baseUrl)
      : async () => null);

  const ladderDeps: LadderDeps = {
    fetch: fetchFn,
    toMarkdown: toMarkdownFn,
  };

  let trackedCount = 0;
  let attempts = 0;
  const MAX_FETCH_PER_RUN = 2;
  const MAX_ATTEMPTS = 5;

  for (const targetUrl of candidateUrls) {
    if (trackedCount >= MAX_FETCH_PER_RUN) break;

    const canonical = normalizeUrl(targetUrl);
    if (!canonical) continue;

    // Check if URL already in articles
    const existing = await deps.db
      .prepare(
        `SELECT id, industry_id, stage, body_sha FROM articles WHERE canonical_url = ?1`,
      )
      .bind(canonical)
      .first<{
        id: number;
        industry_id: number;
        stage: string;
        body_sha: string | null;
      }>();

    if (existing) {
      if (existing.industry_id !== event.industry_id) {
        // Architecture §9 & AGENTS.md §4: articles cannot cross industry boundaries
        continue;
      }

      // Check if this article is already assigned to ANY event
      const assigned = await deps.db
        .prepare(`SELECT event_id FROM event_articles WHERE article_id = ?1`)
        .bind(existing.id)
        .first<{ event_id: number }>();

      // Article belongs to another event or already to this event; cannot re-assign due to unique constraint
      if (assigned) {
        continue;
      }

      // Check if existing article is approved
      const isApproved = await deps.db
        .prepare(
          `SELECT 1 FROM reviews r
           JOIN articles a ON a.id = r.article_id AND r.body_sha = a.body_sha
           WHERE a.id = ?1 AND r.decision = 'approved'`,
        )
        .bind(existing.id)
        .first();

      if (
        isApproved &&
        (existing.stage === "grouped" || existing.stage === "analyzed")
      ) {
        // Link to event and bump revision atomically, verifying approval in-batch
        const batchRes = await deps.db.batch([
          deps.db
            .prepare(
              `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
               SELECT ?1, ?2, ?3, (SELECT revision + 1 FROM events WHERE id = ?1)
               WHERE (SELECT revision FROM events WHERE id = ?1) = ?4
                 AND EXISTS (
                   SELECT 1 FROM reviews r
                   JOIN articles a ON a.id = r.article_id AND r.body_sha = a.body_sha
                   JOIN events e ON e.id = ?1
                   WHERE a.id = ?2 AND r.decision = 'approved' AND a.industry_id = e.industry_id
                 )`,
            )
            .bind(eventId, existing.id, now, event.revision),
          deps.db
            .prepare(
              `UPDATE events SET revision = revision + 1, updated_at = ?1
               WHERE id = ?2 AND revision = ?3 AND changes() = 1`,
            )
            .bind(now, eventId, event.revision),
          deps.db
            .prepare(
              `UPDATE articles SET stage = 'grouped', stage_updated_at = ?1, requeue_count = 0
               WHERE id = ?2 AND stage = 'analyzed'
                 AND EXISTS (
                   SELECT 1 FROM event_articles
                   WHERE event_id = ?3 AND article_id = ?2
                 )`,
            )
            .bind(now, existing.id, eventId),
        ]);

        if (batchRes[0].meta.changes === 1) {
          event.revision += 1;
          trackedCount++;
          const diffStatus = autoApprove ? "published" : "pending_review";
          await syncRevisionDiff(
            deps.db,
            eventId,
            event.revision,
            diffStatus,
            now,
          );
          await deps.qArtifacts?.send({ eventId, kind: "artifacts" });
          await deps.qEvidence?.send({ eventId, kind: "evidence" });
        }
        continue;
      }

      // If existing article was created by primary tracker but its approval batch failed,
      // recover and complete the approval + event linking on retry, BUT NEVER overwrite
      // an administrator rejection or existing review:
      if (!isApproved && !assigned && existing.stage === "grouped") {
        const existingReview = await deps.db
          .prepare(`SELECT decision FROM reviews WHERE article_id = ?1`)
          .bind(existing.id)
          .first<{ decision: string }>();

        if (existingReview?.decision === "rejected") {
          continue;
        }

        if (autoApprove && !existingReview) {
          const bodySha = existing.body_sha || (await sha256Hex(canonical));
          const batchRes = await deps.db.batch([
            deps.db
              .prepare(
                `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
                 VALUES (?1, ?2, 'approved', 'system:primary_tracker', ?3)
                 ON CONFLICT (article_id, body_sha) DO NOTHING`,
              )
              .bind(existing.id, bodySha, now),
            deps.db
              .prepare(
                `INSERT INTO analyses (
                   article_id, prompt_version, scores, content_type, evidence_tags, total_score,
                   prefilter_pass, selected, created_at
                 )
                 VALUES (?1, 'primary_tracker', '{}', 'primary_source', '{"kind":"primary_source"}', 100, 1, 1, ?2)
                 ON CONFLICT (article_id, prompt_version) DO NOTHING`,
              )
              .bind(existing.id, now),
            deps.db
              .prepare(
                `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
                 SELECT ?1, ?2, ?3, (SELECT revision + 1 FROM events WHERE id = ?1)
                 WHERE EXISTS (
                   SELECT 1 FROM reviews
                   WHERE article_id = ?2 AND decision = 'approved'
                 )
                 AND EXISTS (
                   SELECT 1 FROM articles a
                   JOIN events e ON e.id = ?1
                   WHERE a.id = ?2 AND a.industry_id = e.industry_id
                 )`,
              )
              .bind(eventId, existing.id, now),
            deps.db
              .prepare(
                `UPDATE events SET revision = revision + 1, updated_at = ?1
                 WHERE id = ?2 AND changes() = 1`,
              )
              .bind(now, eventId),
          ]);

          if (batchRes[2].meta.changes === 1) {
            event.revision += 1;
            trackedCount++;
            const diffStatus = autoApprove ? "published" : "pending_review";
            await syncRevisionDiff(
              deps.db,
              eventId,
              event.revision,
              diffStatus,
              now,
            );
            await deps.qArtifacts?.send({ eventId, kind: "artifacts" });
            await deps.qEvidence?.send({ eventId, kind: "evidence" });
          }
        }
        continue;
      }
      continue;
    }

    // New URL to fetch via ladder
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      continue;
    }

    // Attribute to the section's matching source, else to its placeholder.
    // Never insert an active source: the source list is the admin's.
    const sourceId =
      (await findAttributionSourceId(
        deps.db,
        event.industry_id,
        parsedUrl.hostname,
      )) ??
      (await ensurePrimaryDocumentsSource(deps.db, event.industry_id, now));

    if (attempts >= MAX_ATTEMPTS) break;
    attempts++;

    // Check robots.txt
    const robots = await checkRobots(
      env,
      targetUrl,
      now,
      fetchFn,
      effectivePrimaryDomains,
    );
    if (!robots.allowed) {
      // Record dropped placeholder so we don't retry endlessly
      await deps.db
        .prepare(
          `INSERT INTO articles (
             source_id, industry_id, canonical_url, url, title, fetched_at,
             stage, stage_updated_at
           )
           SELECT s.id, ?1, ?2, ?3, ?4, ?5, 'dropped', ?5
           FROM sources s
           WHERE s.industry_id = ?1
           LIMIT 1`,
        )
        .bind(event.industry_id, canonical, targetUrl, targetUrl, now)
        .run();
      continue;
    }

    // Claim host slot
    const slot = await claimHostSlot(
      env,
      parsedUrl.host,
      robots.crawlDelaySec ?? 0,
      now,
    );
    if (!slot.claimed) {
      // Rate limited, defer
      continue;
    }

    // Fetch page via ladder
    try {
      const page = await fetchPage(
        env,
        targetUrl,
        now,
        effectivePrimaryDomains,
        ladderDeps,
      );

      if (page.kind === "body") {
        const bodyText = truncateUtf8Bytes(page.body.markdown, MAX_BODY_BYTES);
        const bodySha = await sha256Hex(bodyText);
        const titleMatch = bodyText.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : parsedUrl.hostname;

        const targetStage = autoApprove ? "grouped" : "analyzed";

        // Insert new article
        const insertArtResult = await deps.db
          .prepare(
            `INSERT INTO articles (
               source_id, industry_id, canonical_url, url, title, fetched_at,
               stage, stage_updated_at, fetch_rung, body_sha, body_kind, body_fetched_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?8, ?9, 'full', ?6)
             RETURNING id`,
          )
          .bind(
            sourceId,
            event.industry_id,
            canonical,
            targetUrl,
            title,
            now,
            targetStage,
            page.body.rung,
            bodySha,
          )
          .first<{ id: number }>();

        if (insertArtResult) {
          const newArticleId = insertArtResult.id;

          // Put body into R2 before review / event linking
          if (deps.bodies) {
            try {
              await deps.bodies.put(
                `bodies/${newArticleId}/${bodySha}.md`,
                bodyText,
                {
                  customMetadata: {
                    url: targetUrl,
                    fetchedAt: String(now),
                  },
                },
              );
            } catch (r2Err) {
              await deps.db
                .prepare(`DELETE FROM articles WHERE id = ?1`)
                .bind(newArticleId)
                .run();
              throw r2Err;
            }
          }

          if (!autoApprove) {
            // A non-auto section (Finance always, see effectivePublishMode) needs human review.
            // Left in stage 'analyzed' with no review record, waiting for human decision in /admin/review.
            await deps.db
              .prepare(
                `INSERT INTO analyses (
                   article_id, prompt_version, scores, content_type, evidence_tags, total_score,
                   prefilter_pass, selected, created_at
                 )
                 VALUES (?1, 'primary_tracker', '{}', 'primary_source', ?2, 100, 1, 1, ?3)
                 ON CONFLICT (article_id, prompt_version) DO NOTHING`,
              )
              .bind(
                newArticleId,
                JSON.stringify({
                  kind: "primary_source",
                  origin_event_id: eventId,
                }),
                now,
              )
              .run();
          } else {
            // In D1 batch: approve review, record analysis for evidence tags, add to event_articles, bump event revision
            await deps.db.batch([
              deps.db
                .prepare(
                  `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
                   VALUES (?1, ?2, 'approved', 'system:primary_tracker', ?3)
                   ON CONFLICT (article_id, body_sha) DO NOTHING`,
                )
                .bind(newArticleId, bodySha, now),
              deps.db
                .prepare(
                  `INSERT INTO analyses (
                     article_id, prompt_version, scores, content_type, evidence_tags, total_score,
                     prefilter_pass, selected, created_at
                   )
                   VALUES (?1, 'primary_tracker', '{}', 'primary_source', '{"kind":"primary_source"}', 100, 1, 1, ?2)
                   ON CONFLICT (article_id, prompt_version) DO NOTHING`,
                )
                .bind(newArticleId, now),
              deps.db
                .prepare(
                  `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
                   VALUES (?1, ?2, ?3, (SELECT revision + 1 FROM events WHERE id = ?4))`,
                )
                .bind(eventId, newArticleId, now, eventId),
              deps.db
                .prepare(
                  `UPDATE events SET revision = revision + 1, updated_at = ?1 WHERE id = ?2`,
                )
                .bind(now, eventId),
            ]);

            event.revision += 1;
            trackedCount++;

            // Synchronize deterministic revision diff for the new revision
            const diffStatus = autoApprove ? "published" : "pending_review";
            await syncRevisionDiff(
              deps.db,
              eventId,
              event.revision,
              diffStatus,
              now,
            );

            // Enqueue downstream updates
            await deps.qArtifacts?.send({ eventId, kind: "artifacts" });
            await deps.qEvidence?.send({ eventId, kind: "evidence" });
          }
        }
      } else {
        // Not a body: record dropped placeholder
        await deps.db
          .prepare(
            `INSERT INTO articles (
               source_id, industry_id, canonical_url, url, title, fetched_at,
               stage, stage_updated_at
             )
             SELECT s.id, ?1, ?2, ?3, ?4, ?5, 'dropped', ?5
             FROM sources s
             WHERE s.industry_id = ?1
             LIMIT 1`,
          )
          .bind(event.industry_id, canonical, targetUrl, targetUrl, now)
          .run();
      }
    } catch (e) {
      console.error("Error fetching primary source page", { targetUrl, e });
    }
  }

  // Record that this event was scanned for primary sources (LRU rotation for trackDuePrimarySources)
  await deps.db
    .prepare(
      `INSERT INTO event_artifacts (
         event_id, type, audience, input_revision, prompt_version, model, content, status, created_at
       )
       VALUES (?1, 'primary_tracked', '', ?2, 'v1', 'tracker', '{}', 'published', ?3)
       ON CONFLICT (event_id, type, audience, input_revision, prompt_version, model)
       DO UPDATE SET created_at = excluded.created_at`,
    )
    .bind(eventId, event.revision, now)
    .run();

  return { trackedCount };
}

/**
 * Scheduled job to track primary sources for active events (N§2.2, N§2.5).
 */
export async function trackDuePrimarySources(
  env: PipelineEnv,
  now = Date.now(),
  limit = 10,
): Promise<number[]> {
  if (!isEnabled(env, "COLLECT_ENABLED")) {
    return [];
  }

  const { results } = await env.DB.prepare(
    `SELECT e.id
     FROM events e
     JOIN industries i ON i.id = e.industry_id
     JOIN event_articles ea ON ea.event_id = e.id
     JOIN articles a ON a.id = ea.article_id
     JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
     LEFT JOIN (
       SELECT event_id, MAX(created_at) AS last_scanned_at
       FROM event_artifacts
       WHERE type = 'primary_tracked'
       GROUP BY event_id
     ) pt ON pt.event_id = e.id
     WHERE json_valid(i.primary_domains) = 1
       AND json_array_length(i.primary_domains) > 0
     GROUP BY e.id
     ORDER BY COALESCE(MAX(pt.last_scanned_at), 0) ASC, e.updated_at DESC
     LIMIT ?1`,
  )
    .bind(limit)
    .all<{ id: number }>();

  if (!results || results.length === 0) {
    return [];
  }

  const deps: PrimaryTrackerDeps = {
    db: env.DB,
    bodies: env.BODIES,
    now: () => now,
    qArtifacts: env.Q_GENERATE
      ? { send: (msg) => env.Q_GENERATE!.send(msg) }
      : undefined,
    qEvidence: env.Q_GENERATE
      ? { send: (msg) => env.Q_GENERATE!.send(msg) }
      : undefined,
  };

  const processed: number[] = [];
  for (const row of results) {
    const res = await trackEventPrimarySources(deps, env, row.id, [], now);
    if (res.trackedCount > 0) {
      processed.push(row.id);
    }
  }

  return processed;
}
