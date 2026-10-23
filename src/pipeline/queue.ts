import { toMarkdown } from "../providers/tomarkdown";
import { processBody, type BodyDeps } from "./body/body";
import { collectSource } from "./collect/collect";
import { INGEST_QUEUE, type IngestMessage, type PipelineEnv } from "./messages";

/** fetch and env.AI.toMarkdown(); tests pass fakes. */
function defaultDeps(env: PipelineEnv): BodyDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    toMarkdown: (bytes, mime, baseUrl) => {
      if (!env.AI) return Promise.reject(new Error("no AI binding"));
      return toMarkdown(env.AI, bytes, mime, baseUrl);
    },
  };
}

/** Dispatches by queue, then by message kind (architecture §5). */
export async function runQueue(
  batch: MessageBatch,
  env: PipelineEnv,
  _ctx: ExecutionContext,
  overrides: Partial<BodyDeps> = {},
): Promise<void> {
  if (batch.queue !== INGEST_QUEUE) {
    console.log({ queue: batch.queue, messages: batch.messages.length });
    batch.ackAll();
    return;
  }
  const deps: BodyDeps = { ...defaultDeps(env), ...overrides };
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
        default:
          // analyze: #7. The backfill cron sends these again.
          console.log({ queue: batch.queue, kind: body.kind, handled: false });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error({ queue: batch.queue, message: body, error });
    }
    msg.ack();
  }
}
