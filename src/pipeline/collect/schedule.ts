import { isEnabled } from "../../lib/flags";
import { sendIngest, type PipelineEnv } from "../messages";

/**
 * Claims due sources and sends one `collect` message each. The claim is one
 * UPDATE ... RETURNING, so two overlapping crons never claim the same source.
 * Returns the claimed source ids.
 */
export async function scheduleDueSources(
  env: PipelineEnv,
  now: number,
): Promise<number[]> {
  if (!isEnabled(env, "COLLECT_ENABLED")) return [];
  const { results } = await env.DB.prepare(
    `UPDATE sources SET next_fetch_at = ?1 + interval_minutes * 60000
     WHERE status = 'active' AND next_fetch_at <= ?1
     RETURNING id`,
  )
    .bind(now)
    .all<{ id: number }>();
  const ids = results.map((r) => r.id);
  await sendIngest(
    env,
    ids.map((sourceId) => ({ kind: "collect", sourceId })),
  );
  return ids;
}
