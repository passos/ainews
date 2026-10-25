import { sql } from "drizzle-orm";
import { getDb } from "../../server/db/client";
import { approvedArticleWhere } from "../../server/publication/articles";
import { isEnabled } from "../../lib/flags";
import { FINANCE_SLUG } from "../analyze/analyze";
import { sendGenerate, type PipelineEnv } from "../messages";
import { FUNDING_PROMPT_VERSION } from "./prompts";

/**
 * Approved Finance articles that the analysis classed as a funding round and
 * whose current body has no business completion marker in settings.
 */
export async function enqueueDueFunding(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE" | "MODEL_CALLS_ENABLED">,
  _now: number,
  limit = 20,
): Promise<number[]> {
  if (!env.Q_GENERATE || !isEnabled(env, "MODEL_CALLS_ENABLED")) return [];

  const results = await getDb(env.DB).all<{ id: number }>(sql`
    SELECT a.id FROM articles a JOIN industries i ON i.id = a.industry_id
    WHERE i.slug = ${FINANCE_SLUG} AND a.body_sha IS NOT NULL
      AND ${approvedArticleWhere}
      AND EXISTS (SELECT 1 FROM analyses an WHERE an.article_id = a.id
        AND an.content_type = 'funding_round')
      AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key =
        'funding:done:' || a.id || ':' || ${FUNDING_PROMPT_VERSION} || ':' || a.body_sha)
    ORDER BY a.id ASC LIMIT ${limit}`);

  const ids = (results ?? []).map((r) => r.id);
  if (ids.length === 0) return [];
  await sendGenerate(
    env,
    ids.map((articleId) => ({ kind: "funding", articleId })),
  );
  return ids;
}
