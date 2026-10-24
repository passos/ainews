import type { ModelTransport } from "../../providers/transport";
import { buildDailyDigest } from "../digest/build";
import type { GenerateMessage, PipelineEnv } from "../messages";

export interface GenerateConsumerDeps {
  transport?: ModelTransport;
}

export async function handleGenerateBatch(
  batch: MessageBatch<GenerateMessage>,
  env: PipelineEnv,
  overrides: Partial<GenerateConsumerDeps> = {},
): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body;
    try {
      switch (body.kind) {
        case "digest":
          await buildDailyDigest(env, body, Date.now(), overrides);
          break;
        default:
          console.error({
            queue: batch.queue,
            message: body,
            error: "unknown generate kind",
          });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error({ queue: batch.queue, message: body, error });
    }
    msg.ack();
  }
}
