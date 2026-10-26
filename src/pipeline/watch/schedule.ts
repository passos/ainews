import { enqueueDueEvents } from "../due-events";
import type { PipelineEnv } from "../messages";

/**
 * Enqueues events whose current revision has no finished watch evaluation
 * (`watch_evaluated_revision < revision`), through the shared due-event check
 * (#92). It runs even without an active watch, so the revisions approved
 * meanwhile get marked and a new watch does not evaluate them all at once.
 */
export async function enqueueDueWatches(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  now: number,
  limit = 20,
): Promise<number[]> {
  return enqueueDueEvents(env, "watch", now, limit);
}
