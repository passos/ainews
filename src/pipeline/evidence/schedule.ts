import { enqueueDueEvents } from "../due-events";
import type { PipelineEnv } from "../messages";

export async function enqueueDueEvidence(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  now: number,
  limit = 20,
): Promise<number[]> {
  return enqueueDueEvents(env, "evidence", now, limit);
}
