import { enqueueDueArtifacts } from "./artifacts/schedule";
import { scheduleDueSources } from "./collect/schedule";
import { enqueueDueDigests } from "./digest/schedule";
import { pollDueCompanies } from "./edgar/schedule";
import { enqueueDueEvidence } from "./evidence/schedule";
import { enqueueDueFunding } from "./funding/schedule";
import { trackDuePrimarySources } from "./evidence/primary";
import type { PipelineEnv } from "./messages";
import { requeueStuck } from "./requeue";
import { enqueueDueWatches } from "./watch/schedule";

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
  const tracked = await trackDuePrimarySources(env, now);
  const evidence = await enqueueDueEvidence(env, now);
  const watches = await enqueueDueWatches(env, now);
  const edgar = await pollDueCompanies(env, now);
  const funding = await enqueueDueFunding(env, now);
  console.log({
    cron: controller.cron,
    claimed: claimed.length,
    requeued: requeued.length,
    digests: digests.length,
    artifacts: artifacts.length,
    tracked: tracked.length,
    evidence: evidence.length,
    watches: watches.length,
    edgar: edgar.polledCount,
    funding: funding.length,
  });
}
