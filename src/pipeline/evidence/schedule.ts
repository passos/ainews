import { sendGenerate, type PipelineEnv } from "../messages";

export async function enqueueDueEvidence(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  _now: number,
  limit = 20,
): Promise<number[]> {
  if (!env.Q_GENERATE) {
    return [];
  }

  // Find events with approved articles where current revision does not have completed claims
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
       AND NOT EXISTS (
         SELECT 1 FROM claims c
         WHERE c.event_id = e.id
           AND c.input_revision = e.revision
           AND c.claim_text IN ('[no_verifiable_claims]', '[evidence_batch_complete]')
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
    ids.map((eventId) => ({ kind: "evidence", eventId })),
  );

  return ids;
}
