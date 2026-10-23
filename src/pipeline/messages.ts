// The only definition of Q_INGEST messages (architecture §5: messages carry
// ids only). Handlers are in queue.ts.

/** Queue name of Q_INGEST in wrangler.jsonc; MessageBatch.queue carries it. */
export const INGEST_QUEUE = "ainews-ingest";

export type IngestMessage =
  | { kind: "collect"; sourceId: number }
  | { kind: "body"; articleId: number }
  | { kind: "analyze"; articleId: number };

/** Bindings and flags the pipeline reads. `Env` satisfies it. */
export type PipelineEnv = Pick<Env, "DB" | "BODIES" | "Q_INGEST" | "AI"> & {
  /** Model calls go through this AI Gateway (wrangler var). */
  AI_GATEWAY_ID?: string;
  COLLECT_ENABLED?: string;
  MODEL_CALLS_ENABLED?: string;
  THIRD_PARTY_READER_ENABLED?: string;
  /** Secret (wrangler secret), not a var. */
  JINA_API_KEY?: string;
};

/** Queues sendBatch takes at most 100 messages (or 256 KB) per call. */
const SEND_BATCH_MAX = 100;

export async function sendIngest(
  env: Pick<PipelineEnv, "Q_INGEST">,
  messages: IngestMessage[],
): Promise<void> {
  for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) {
    await env.Q_INGEST.sendBatch(
      messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })),
    );
  }
}
