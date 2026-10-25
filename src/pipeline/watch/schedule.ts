import { sendGenerate, type PipelineEnv } from "../messages";

export async function enqueueDueWatches(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  _now: number,
  limit = 20,
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

  // Find events with approved articles and revision > 0
  const { results } = await env.DB.prepare(
    `SELECT e.id
     FROM events e
     WHERE e.revision > 0
       AND EXISTS (
         SELECT 1 FROM event_articles ea
         JOIN articles a ON a.id = ea.article_id
         JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
         WHERE ea.event_id = e.id
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
