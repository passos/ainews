import { enqueueDueArtifacts } from "./artifacts/schedule";
import { scheduleDueSources } from "./collect/schedule";
import { enqueueDueDigests } from "./digest/schedule";
import type { PipelineEnv } from "./messages";
import { requeueStuck } from "./requeue";

/** Cron, every 10 minutes (wrangler.jsonc). */
export async function runScheduled(
  controller: ScheduledController,
  env: PipelineEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const now = controller.scheduledTime;
  const claimed = await scheduleDueSources(env, now);
  const requeued = await requeueStuck(env, now);
  const digests = await enqueueDueDigests(env, now);
  const artifacts = await enqueueDueArtifacts(env, now);
  console.log({
    cron: controller.cron,
    claimed: claimed.length,
    requeued: requeued.length,
    digests: digests.length,
    artifacts: artifacts.length,
  });
}
