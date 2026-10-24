import { CallInProgressError } from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import { buildDailyDigest } from "../digest/build";
import type { GenerateMessage, PipelineEnv } from "../messages";

export interface GenerateConsumerDeps {
  transport?: ModelTransport;
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
          await buildDailyDigest(env, body, Date.now(), deps);
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
      if (e instanceof CallInProgressError) {
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
