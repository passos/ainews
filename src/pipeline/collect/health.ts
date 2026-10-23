// Source health: consecutive failures, empty fetches, automatic pauses.
// Resuming a paused source is #9 (status='active', fail_count=0).

/** Consecutive failures that pause a source. */
export const FAIL_PAUSE_THRESHOLD = 5;
/**
 * Fetched time without anything new that pauses a source as 'stale':
 * empty_fetches * interval_minutes >= this. It counts actual fetches, so
 * time with COLLECT_ENABLED off (or the source paused) does not count.
 */
export const STALE_AFTER_MINUTES = 30 * 24 * 60;
const ERROR_MAX = 500;

/**
 * A fetch that worked (200 and parsed, or 304). `sightings` = articles this
 * source saw for the first time in it: 0 counts as an empty fetch. One
 * statement, so the count and the pause cannot disagree.
 */
export async function recordSuccess(
  db: D1Database,
  sourceId: number,
  now: number,
  cache: { etag: string | null; lastModified: string | null },
  sightings: number,
): Promise<void> {
  const empty = sightings > 0 ? 0 : 1;
  await db
    .prepare(
      `UPDATE sources SET fail_count = 0, last_ok_at = ?2,
         etag = COALESCE(?3, etag), last_modified = COALESCE(?4, last_modified),
         empty_fetches = CASE WHEN ?5 = 1 THEN empty_fetches + 1 ELSE 0 END,
         status = CASE WHEN ?5 = 1
             AND (empty_fetches + 1) * interval_minutes >= ?6
           THEN 'paused' ELSE status END,
         paused_reason = CASE WHEN ?5 = 1
             AND (empty_fetches + 1) * interval_minutes >= ?6
           THEN 'stale' ELSE paused_reason END
       WHERE id = ?1`,
    )
    .bind(
      sourceId,
      now,
      cache.etag,
      cache.lastModified,
      empty,
      STALE_AFTER_MINUTES,
    )
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
