// The only definition of Q_INGEST messages (architecture §5: messages carry
// ids only). Handlers are in queue.ts.

/** Queue name of Q_INGEST in wrangler.jsonc; MessageBatch.queue carries it. */
export const INGEST_QUEUE = "ainews-ingest";
/** Queue name of Q_GROUP in wrangler.jsonc; MessageBatch.queue carries it. */
export const GROUP_QUEUE = "ainews-group";
/** Queue name of Q_GENERATE in wrangler.jsonc; MessageBatch.queue carries it. */
export const GENERATE_QUEUE = "ainews-generate";

export type IngestMessage =
  | { kind: "collect"; sourceId: number }
  | { kind: "body"; articleId: number }
  | { kind: "analyze"; articleId: number };

export type GroupMessage = { kind: "group"; articleId: number };

export type DigestMessage = {
  kind: "digest";
  industryId: number;
  digestKind: "daily";
  /** "YYYY-MM-DD" */
  periodStart: string;
};

export type ArtifactsMessage = {
  kind: "artifacts";
  eventId: number;
};

export type EvidenceMessage = {
  kind: "evidence";
  eventId: number;
};

export type AskMessage = {
  kind: "ask";
  questionId: number;
};

export type DiscoverMessage = {
  kind: "discover";
  runId: number;
};

export type GenerateMessage =
  | DigestMessage
  | ArtifactsMessage
  | EvidenceMessage
  | AskMessage
  | DiscoverMessage;

/** Bindings and flags the pipeline reads. `Env` satisfies it. */
export type PipelineEnv = Pick<Env, "DB" | "BODIES" | "Q_INGEST"> & {
  Q_GROUP?: Queue;
  Q_GENERATE?: Queue;
  V_EVENTS?: VectorizeIndex;
  V_CHUNKS?: VectorizeIndex;
  AI?: Env["AI"];
  /** Model calls go through this AI Gateway (wrangler var). */
  AI_GATEWAY_ID?: string;
  SITE_URL?: string;
  ADMIN_EMAIL?: string;
  EMAIL_FROM?: string;
  COLLECT_ENABLED?: string;
  MODEL_CALLS_ENABLED?: string;
  EMAIL_ENABLED?: string;
  THIRD_PARTY_READER_ENABLED?: string;
  DISCOVERY_ENABLED?: string;
  /** Secret (wrangler secret), not a var. */
  JINA_API_KEY?: string;
  EMAIL?: SendEmail;
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

export async function sendGroup(
  env: Pick<PipelineEnv, "Q_GROUP">,
  messages: GroupMessage[],
): Promise<void> {
  if (!env.Q_GROUP) return;
  for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) {
    await env.Q_GROUP.sendBatch(
      messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })),
    );
  }
}

export async function sendGenerate(
  env: Pick<PipelineEnv, "Q_GENERATE">,
  messages: GenerateMessage[],
): Promise<void> {
  if (!env.Q_GENERATE) return;
  for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) {
    await env.Q_GENERATE.sendBatch(
      messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })),
    );
  }
}
