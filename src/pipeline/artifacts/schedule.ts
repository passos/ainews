import { sendGenerate, type PipelineEnv } from "../messages";

export async function enqueueDueArtifacts(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  _now: number,
  limit = 20,
): Promise<number[]> {
  if (!env.Q_GENERATE) {
    return [];
  }

  // Find events with approved articles where current revision is missing story_brief, deep explainers, learning material, or earnings decoder
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
       AND (
         NOT EXISTS (
           SELECT 1 FROM event_artifacts ea2
           WHERE ea2.event_id = e.id
             AND ea2.input_revision = e.revision
             AND ea2.type = 'story_brief'
         )
         OR (
           EXISTS (
             SELECT 1 FROM event_articles ea3
             JOIN analyses an ON an.article_id = ea3.article_id
             WHERE ea3.event_id = e.id AND an.total_score >= 80
           )
           AND (
             NOT EXISTS (
               SELECT 1 FROM event_artifacts ea4
               WHERE ea4.event_id = e.id
                 AND ea4.input_revision = e.revision
                 AND ea4.type = 'audience_explain'
             )
             OR NOT EXISTS (
               SELECT 1 FROM event_artifacts ea5
               WHERE ea5.event_id = e.id
                 AND ea5.input_revision = e.revision
                 AND ea5.type = 'learning_material'
             )
           )
         )
         OR (
           EXISTS (
             SELECT 1 FROM event_articles ea_f
             JOIN filings f ON f.article_id = ea_f.article_id
             WHERE ea_f.event_id = e.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM event_artifacts ea_ed
             WHERE ea_ed.event_id = e.id
               AND ea_ed.input_revision = e.revision
               AND ea_ed.type = 'earnings_decoder'
           )
         )
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
    ids.map((eventId) => ({ kind: "artifacts", eventId })),
  );

  return ids;
}
