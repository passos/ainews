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
