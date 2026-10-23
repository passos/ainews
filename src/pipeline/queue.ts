import { collectSource, type CollectDeps } from "./collect/collect";
import { INGEST_QUEUE, type IngestMessage, type PipelineEnv } from "./messages";

const defaultDeps: CollectDeps = { fetch: (input, init) => fetch(input, init) };

/** Dispatches by queue, then by message kind (architecture §5). */
export async function runQueue(
  batch: MessageBatch,
  env: PipelineEnv,
  _ctx: ExecutionContext,
  deps: CollectDeps = defaultDeps,
): Promise<void> {
  if (batch.queue !== INGEST_QUEUE) {
    console.log({ queue: batch.queue, messages: batch.messages.length });
    batch.ackAll();
    return;
  }
  for (const msg of batch.messages as readonly Message<IngestMessage>[]) {
    const body = msg.body;
    switch (body.kind) {
      case "collect":
        await collectSource(env, body.sourceId, Date.now(), deps);
        break;
      default:
        // body: #6, analyze: #7. The backfill cron sends these again.
        console.log({ queue: batch.queue, kind: body.kind, handled: false });
    }
    msg.ack();
  }
}
