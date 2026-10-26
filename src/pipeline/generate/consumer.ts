import {
  BudgetExceededError,
  CallInProgressError,
} from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import { generateEventArtifacts } from "../artifacts/build";
import { answerQuestion } from "../ask/answer";
import { buildDigest } from "../digest/build";
import { generateEventEvidence } from "../evidence/build";
import { runDiscovery, type DiscoverDeps } from "../discover/run";
import { evaluateEventWatches, type WatchDeps } from "../watch/evaluate";
import type { GenerateMessage, PipelineEnv } from "../messages";

export interface GenerateConsumerDeps {
  transport?: ModelTransport;
  discoverDeps?: DiscoverDeps;
  watchDeps?: WatchDeps;
}

function defaultDeps(
  env: PipelineEnv,
  overrides: Partial<GenerateConsumerDeps>,
): GenerateConsumerDeps {
  const transport =
    overrides.transport ??
    (env.AI
      ? bindingTransport(env.AI, env.AI_GATEWAY_ID ?? "")
      : {
          run: () => Promise.reject(new Error("no AI binding")),
        });
  return { transport };
}

export async function handleGenerateBatch(
  batch: MessageBatch<GenerateMessage>,
  env: PipelineEnv,
  overrides: Partial<GenerateConsumerDeps> = {},
): Promise<void> {
  const deps = defaultDeps(env, overrides);

  for (const msg of batch.messages) {
    const body = msg.body;
    try {
      switch (body.kind) {
        case "digest":
          await buildDigest(env, body, Date.now(), deps);
          break;
        case "artifacts":
          await generateEventArtifacts(env, body.eventId, Date.now(), deps);
          break;
        case "evidence":
          await generateEventEvidence(env, body.eventId, Date.now(), deps);
          break;
        case "ask":
          await answerQuestion(env, body.questionId, Date.now(), deps);
          break;
        case "discover":
          await runDiscovery(
            env,
            body.runId,
            Date.now(),
            overrides.discoverDeps,
          );
          break;
        case "watch":
          await evaluateEventWatches(
            env,
            body.eventId,
            Date.now(),
            overrides.watchDeps,
          );
          break;
        default:
          console.error({
            queue: batch.queue,
            message: body,
            error: "unknown generate kind",
          });
      }
      msg.ack();
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        // Not retried: the cron due-event scans resend artifacts, evidence
        // and watch kinds once the budget allows (#116).
        console.warn({ generate: body, error: e.name, message: e.message });
        msg.ack();
      } else if (e instanceof CallInProgressError) {
        console.warn({
          digest: body,
          error: e.name,
          message: e.message,
        });
        msg.retry();
      } else {
        const error = e instanceof Error ? e.message : String(e);
        console.error({ queue: batch.queue, message: body, error });
        msg.retry();
      }
    }
  }
}
