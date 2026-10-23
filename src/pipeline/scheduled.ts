import { pauseStale } from "./collect/health";
import { scheduleDueSources } from "./collect/schedule";
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
  const paused = await pauseStale(env, now);
  const requeued = await requeueStuck(env, now);
  console.log({
    cron: controller.cron,
    claimed: claimed.length,
    paused: paused.length,
    requeued: requeued.length,
  });
}
