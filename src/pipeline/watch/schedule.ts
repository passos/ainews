import { sendGenerate, type PipelineEnv } from "../messages";
import { APPROVED_ARTICLE_SQL } from "../../server/publication/articles";

/**
 * Enqueues events whose current revision has no finished watch evaluation
 * (`watch_evaluated_revision < revision`). No time window: an old event is
 * picked up once the newer ones are marked. It runs even without an active
 * watch, so the revisions approved meanwhile get marked and a new watch does
 * not evaluate them all at once.
 */
export async function enqueueDueWatches(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  _now: number,
  limit = 20,
): Promise<number[]> {
  if (!env.Q_GENERATE || !env.DB) {
    return [];
  }

  const { results } = await env.DB.prepare(
    `SELECT e.id
     FROM events e
     WHERE e.revision > 0
       AND e.revision > e.watch_evaluated_revision
       AND EXISTS (
         SELECT 1 FROM event_articles ea
         JOIN articles a ON a.id = ea.article_id
         WHERE ea.event_id = e.id AND ${APPROVED_ARTICLE_SQL}
       )
     ORDER BY e.updated_at DESC
     LIMIT ?1`,
  )
    .bind(limit)
    .all<{ id: number }>();

  if (!results || results.length === 0) {
    return [];
  }

  const ids = results.map((r) => r.id);
  await sendGenerate(
    env,
    ids.map((eventId) => ({ kind: "watch", eventId })),
  );

  return ids;
}
