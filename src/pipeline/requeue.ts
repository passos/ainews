// Backfill (architecture §5): rows whose stage has not changed for 30
// minutes are sent again. dropped and grouped are final; analyzed -> group
// goes to Q_GROUP and is added by #11.
// Contract (architecture §5): every statement that writes `stage` also sets
// stage_updated_at = now and requeue_count = 0, so the requeues of one stage
// do not use up those of the next.
import { isEnabled, type SafetyFlag } from "../lib/flags";
import {
  sendGroup,
  sendIngest,
  type IngestMessage,
  type PipelineEnv,
} from "./messages";

export const STUCK_AFTER_MS = 30 * 60_000;
export const MAX_REQUEUES = 3;

export const STAGE_NEXT = {
  collected: "body",
  body_ready: "analyze",
} as const satisfies Record<string, IngestMessage["kind"]>;

/** The step a message kind starts; it is skipped while its flag is off. */
const KIND_FLAG: Record<
  (typeof STAGE_NEXT)[keyof typeof STAGE_NEXT],
  SafetyFlag
> = {
  body: "COLLECT_ENABLED",
  analyze: "MODEL_CALLS_ENABLED",
};

/** Returns the article ids sent again. */
export async function requeueStuck(
  env: PipelineEnv,
  now: number,
): Promise<number[]> {
  const sent: number[] = [];
  for (const [stage, kind] of Object.entries(STAGE_NEXT)) {
    if (!isEnabled(env, KIND_FLAG[kind])) continue;
    const { results } = await env.DB.prepare(
      `UPDATE articles SET stage_updated_at = ?1,
         requeue_count = requeue_count + 1
       WHERE stage = ?2 AND stage_updated_at < ?3 AND requeue_count < ?4
       RETURNING id`,
    )
      .bind(now, stage, now - STUCK_AFTER_MS, MAX_REQUEUES)
      .all<{ id: number }>();
    const ids = results.map((r) => r.id);
    await sendIngest(
      env,
      ids.map((articleId) => ({ kind, articleId })),
    );
    sent.push(...ids);
  }
  if (isEnabled(env, "MODEL_CALLS_ENABLED") && env.Q_GROUP) {
    const { results } = await env.DB.prepare(
      `UPDATE articles SET stage_updated_at = ?1,
         requeue_count = requeue_count + 1
       WHERE stage = 'analyzed' AND stage_updated_at < ?2 AND requeue_count < ?3
       RETURNING id`,
    )
      .bind(now, now - STUCK_AFTER_MS, MAX_REQUEUES)
      .all<{ id: number }>();
    const ids = results.map((r) => r.id);
    await sendGroup(
      env,
      ids.map((articleId) => ({ kind: "group", articleId })),
    );
    sent.push(...ids);
  }
  return sent;
}
