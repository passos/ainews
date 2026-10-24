import { toMarkdown } from "../providers/tomarkdown";
import { bindingTransport } from "../providers/transport";
import { analyzeArticle, type AnalyzeDeps } from "./analyze/analyze";
import { processBody, type BodyDeps } from "./body/body";
import { collectSource } from "./collect/collect";
import { persistDeadLetters } from "./dlq";
import {
  handleGenerateBatch,
  type GenerateConsumerDeps,
} from "./generate/consumer";
import { handleGroupBatch, type GroupConsumerDeps } from "./group/consumer";
import {
  GENERATE_QUEUE,
  GROUP_QUEUE,
  INGEST_QUEUE,
  type GenerateMessage,
  type IngestMessage,
  type PipelineEnv,
} from "./messages";

export type QueueDeps = BodyDeps &
  AnalyzeDeps &
  GroupConsumerDeps &
  GenerateConsumerDeps;

/** fetch, env.AI.toMarkdown() and env.AI.run() via AI Gateway; tests pass fakes. */
function defaultDeps(env: PipelineEnv): QueueDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    toMarkdown: (bytes, mime, baseUrl) => {
      if (!env.AI) return Promise.reject(new Error("no AI binding"));
      return toMarkdown(env.AI, bytes, mime, baseUrl);
    },
    transport: {
      run: async (model, input) => {
        if (!env.AI) throw new Error("no AI binding");
        return bindingTransport(env.AI, env.AI_GATEWAY_ID ?? "").run(
          model,
          input,
        );
      },
    },
  };
}

/** Dispatches by queue, then by message kind (architecture §5). */
export async function runQueue(
  batch: MessageBatch,
  env: PipelineEnv,
  _ctx: ExecutionContext,
  overrides: Partial<QueueDeps> = {},
): Promise<void> {
  if (batch.queue === "ainews-dlq") {
    await persistDeadLetters(batch, env);
    return;
  }
  if (batch.queue === GROUP_QUEUE) {
    await handleGroupBatch(batch, env, overrides);
    return;
  }
  const deps: QueueDeps = { ...defaultDeps(env), ...overrides };
  if (batch.queue === GENERATE_QUEUE) {
    await handleGenerateBatch(
      batch as MessageBatch<GenerateMessage>,
      env,
      deps,
    );
    return;
  }
  if (batch.queue !== INGEST_QUEUE) {
    console.log({ queue: batch.queue, messages: batch.messages.length });
    batch.ackAll();
    return;
  }
  for (const msg of batch.messages as readonly Message<IngestMessage>[]) {
    const body = msg.body;
    // One failing message does not stop the batch. It is acked like a
    // failed collect: the next due time or the backfill cron (requeue.ts)
    // sends it again, and msg.retry() would only add DLQ entries.
    try {
      switch (body.kind) {
        case "collect":
          await collectSource(env, body.sourceId, Date.now(), deps);
          break;
        case "body":
          // A crawl-delay wait sends the message again with a delay and acks
          // this one: msg.retry() would use up max_retries and end in the DLQ.
          await processBody(env, body.articleId, Date.now(), deps);
          break;
        case "analyze":
          // Budget, config and model errors are handled inside; the
          // backfill cron sends the message again.
          await analyzeArticle(env, body.articleId, Date.now(), deps);
          break;
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error({ queue: batch.queue, message: body, error });
    }
    msg.ack();
  }
}
