// Source health: consecutive failures, last success, automatic pauses.
// Resuming a paused source is #9 (status='active', fail_count=0).

/** Consecutive failures that pause a source. */
export const FAIL_PAUSE_THRESHOLD = 5;
export const STALE_AFTER_MS = 30 * 24 * 60 * 60_000;
const ERROR_MAX = 500;

export async function recordSuccess(
  db: D1Database,
  sourceId: number,
  now: number,
  cache: { etag: string | null; lastModified: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE sources SET fail_count = 0, last_ok_at = ?2,
         etag = COALESCE(?3, etag), last_modified = COALESCE(?4, last_modified)
       WHERE id = ?1`,
    )
    .bind(sourceId, now, cache.etag, cache.lastModified)
    .run();
}

/** One statement, so concurrent failures cannot lose a count. */
export async function recordFailure(
  db: D1Database,
  sourceId: number,
  now: number,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sources SET fail_count = fail_count + 1, last_failed_at = ?2,
         last_error = ?3,
         status = CASE WHEN fail_count + 1 >= ?4 THEN 'paused' ELSE status END,
         paused_reason = CASE WHEN fail_count + 1 >= ?4 THEN 'failing'
           ELSE paused_reason END
       WHERE id = ?1`,
    )
    .bind(sourceId, now, error.slice(0, ERROR_MAX), FAIL_PAUSE_THRESHOLD)
    .run();
}

/**
 * Pauses active sources that are older than 30 days, were fetched
 * successfully in the last 30 days, and saw no new article in that time.
 * The last_ok_at condition keeps sources running after a long period with
 * COLLECT_ENABLED off: they were not fetched, so they are not stale.
 */
export async function pauseStale(
  env: { DB: D1Database },
  now: number,
): Promise<number[]> {
  const since = now - STALE_AFTER_MS;
  const { results } = await env.DB.prepare(
    `UPDATE sources SET status = 'paused', paused_reason = 'stale'
       WHERE status = 'active' AND created_at <= ?1 AND last_ok_at >= ?1
         AND NOT EXISTS (SELECT 1 FROM article_sightings s
           WHERE s.source_id = sources.id AND s.seen_at >= ?1)
       RETURNING id`,
  )
    .bind(since)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/** Articles first seen by the source since `since` ("last 7 days" metric). */
export async function countSightings(
  db: D1Database,
  sourceId: number,
  since: number,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM article_sightings WHERE source_id = ?1 AND seen_at >= ?2",
    )
    .bind(sourceId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
