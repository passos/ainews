import { sendGenerate, type PipelineEnv } from "../messages";
import { APPROVED_ARTICLE_SQL } from "../../server/publication/articles";

export async function enqueueDueWatches(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  now: number,
  limit = 20,
  windowMs = 30 * 60 * 1000,
): Promise<number[]> {
  if (!env.Q_GENERATE || !env.DB) {
    return [];
  }

  // Check if there are any active watches
  const activeWatch = await env.DB.prepare(
    `SELECT 1 FROM watches WHERE status = 'active' LIMIT 1`,
  ).first();

  if (!activeWatch) {
    return [];
  }

  const since = now - windowMs;

  // Find events with approved articles and revision > 0 updated within the window
  const { results } = await env.DB.prepare(
    `SELECT e.id
     FROM events e
     WHERE e.revision > 0
       AND e.updated_at >= ?1
       AND EXISTS (
         SELECT 1 FROM event_articles ea
         JOIN articles a ON a.id = ea.article_id
         WHERE ea.event_id = e.id AND ${APPROVED_ARTICLE_SQL}
       )
     ORDER BY e.updated_at DESC
     LIMIT ?2`,
  )
    .bind(since, limit)
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
