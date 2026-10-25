import type { PipelineEnv } from "../messages";
import { checkRobots, claimHostSlot } from "../body/robots";
import { fetchPage, type LadderDeps, type ToMarkdown } from "../body/ladder";
import { extractWhitelistedUrls } from "./verify";
import { normalizeUrl } from "../../lib/url";
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
      `SELECT e.id, e.industry_id, e.revision, i.primary_domains
       FROM events e
       JOIN industries i ON i.id = e.industry_id
       WHERE e.id = ?1`,
    )
    .bind(eventId)
    .first<EventRow>();

  if (!event) {
    return { trackedCount: 0 };
  }

  let effectivePrimaryDomains = primaryDomains;
  if (effectivePrimaryDomains.length === 0 && event.primary_domains) {
    try {
      effectivePrimaryDomains = JSON.parse(event.primary_domains);
    } catch {
      effectivePrimaryDomains = [];
    }
  }

  if (effectivePrimaryDomains.length === 0) {
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
  const MAX_FETCH_PER_RUN = 2;

  for (const targetUrl of candidateUrls) {
    if (trackedCount >= MAX_FETCH_PER_RUN) break;

    const canonical = normalizeUrl(targetUrl);
    if (!canonical) continue;

    // Check if URL already in articles
    const existing = await deps.db
      .prepare(`SELECT id, stage FROM articles WHERE canonical_url = ?1`)
      .bind(canonical)
      .first<{ id: number; stage: string }>();

    if (existing) {
      // If already exists, check if in event_articles
      const linked = await deps.db
        .prepare(
          `SELECT 1 FROM event_articles WHERE event_id = ?1 AND article_id = ?2`,
        )
        .bind(eventId, existing.id)
        .first();

      if (!linked && existing.stage === "grouped") {
        // Link to event
        await deps.db
          .prepare(
            `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
             SELECT ?1, ?2, ?3, (SELECT revision + 1 FROM events WHERE id = ?1)
             WHERE (SELECT revision FROM events WHERE id = ?1) = ?4`,
          )
          .bind(eventId, existing.id, now, event.revision)
          .run();

        await deps.db
          .prepare(
            `UPDATE events SET revision = revision + 1, updated_at = ?1 WHERE id = ?2`,
          )
          .bind(now, eventId)
          .run();

        trackedCount++;
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
        const bodyText = page.body.markdown;
        const bodySha = await sha256Hex(bodyText);
        const title = parsedUrl.hostname;

        // Find or create source for this domain
        const hostFeedUrl = `https://${parsedUrl.hostname}`;
        await deps.db
          .prepare(
            `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
             VALUES (?1, ?2, ?3, ?2, 'html', 'active', ?4)
             ON CONFLICT (industry_id, feed_url) DO UPDATE SET name = excluded.name`,
          )
          .bind(event.industry_id, parsedUrl.hostname, hostFeedUrl, now)
          .run();

        const sourceRow = await deps.db
          .prepare(
            `SELECT id FROM sources WHERE industry_id = ?1 AND feed_url = ?2`,
          )
          .bind(event.industry_id, hostFeedUrl)
          .first<{ id: number }>();

        const sourceId = sourceRow ? sourceRow.id : 1;

        // Insert new article as grouped
        const insertArtResult = await deps.db
          .prepare(
            `INSERT INTO articles (
               source_id, industry_id, canonical_url, url, title, fetched_at,
               stage, stage_updated_at, fetch_rung, body_sha, body_kind, body_fetched_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'grouped', ?6, ?7, ?8, 'full', ?6)
             RETURNING id`,
          )
          .bind(
            sourceId,
            event.industry_id,
            canonical,
            targetUrl,
            title,
            now,
            page.body.rung,
            bodySha,
          )
          .first<{ id: number }>();

        if (insertArtResult) {
          const newArticleId = insertArtResult.id;

          // Put body into R2
          if (deps.bodies) {
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
          }

          // In D1 batch: approve review, add to event_articles, bump event revision
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

          trackedCount++;

          // Enqueue downstream updates
          await deps.qArtifacts?.send({ eventId, kind: "artifacts" });
          await deps.qEvidence?.send({ eventId, kind: "evidence" });
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
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT e.id
     FROM events e
     JOIN event_articles ea ON ea.event_id = e.id
     JOIN articles a ON a.id = ea.article_id
     JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
     ORDER BY e.updated_at DESC
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
