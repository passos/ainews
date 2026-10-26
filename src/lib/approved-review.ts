/**
 * Admin-side "is this article approved" check: one approving review for the
 * article's current body. The SQL definition lives in
 * src/server/publication/articles.ts (APPROVED_ARTICLE_SQL).
 */
export function isApprovedReview(
  review: { bodySha: string; decision: string },
  articleBodySha: string | null | undefined,
): boolean {
  return review.bodySha === articleBodySha && review.decision === "approved";
}
