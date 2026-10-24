export function revisionBumpStatement(
  database: D1Database,
  articleId: number,
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE events
       SET revision = revision + 1, updated_at = ?1
       WHERE id = (SELECT event_id FROM event_articles WHERE article_id = ?2)`,
    )
    .bind(now, articleId);
}

/**
 * Conditional revision bump for review decisions (architecture §6):
 * Atomically bumps event revision within a batch IF and ONLY IF the approval state flips:
 * - target decision is 'approved' and it was not approved before; OR
 * - target decision is 'rejected' and it WAS approved before.
 * Must execute before the INSERT/UPDATE reviews statement in the same batch.
 */
export function conditionalReviewRevisionBumpStatement(
  database: D1Database,
  articleId: number,
  bodySha: string,
  targetDecision: "approved" | "rejected",
  now: number,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE events
       SET revision = revision + 1, updated_at = ?1
       WHERE id = (SELECT event_id FROM event_articles WHERE article_id = ?2)
         AND (
           (?3 = 'approved' AND NOT EXISTS (
             SELECT 1 FROM reviews
             WHERE article_id = ?2 AND body_sha = ?4 AND decision = 'approved'
           ))
           OR
           (?3 = 'rejected' AND EXISTS (
             SELECT 1 FROM reviews
             WHERE article_id = ?2 AND body_sha = ?4 AND decision = 'approved'
           ))
         )`,
    )
    .bind(now, articleId, targetDecision, bodySha);
}
