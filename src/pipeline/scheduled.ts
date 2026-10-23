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
  const requeued = await requeueStuck(env, now);
  console.log({
    cron: controller.cron,
    claimed: claimed.length,
    requeued: requeued.length,
  });
}
