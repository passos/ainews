import { isEnabled } from "../../lib/flags";
import {
  BudgetExceededError,
  CallFailedError,
  CallInProgressError,
  CallUnknownError,
  createModelClient,
  type ModelClient,
} from "../../providers/models";
import { CALL_TIERS } from "../../providers/tiers";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import { sendGenerate, type GroupMessage, type PipelineEnv } from "../messages";
import { groupArticle, type GroupArticleDeps } from "./group-article";

export interface GroupConsumerDeps {
  vectors?: GroupArticleDeps["vectors"];
  models?: ModelClient;
  transport?: ModelTransport;
  now?: () => number;
}

function defaultDeps(
  env: PipelineEnv,
  overrides: GroupConsumerDeps,
  nowTime: number,
): GroupArticleDeps {
  const transport =
    overrides.transport ??
    (env.AI
      ? bindingTransport(env.AI, env.AI_GATEWAY_ID ?? "")
      : {
          run: () => Promise.reject(new Error("no AI binding")),
        });

  const models =
    overrides.models ??
    createModelClient({
      tier: CALL_TIERS.group,
      db: env.DB,
      transport,
      env,
      now: overrides.now ?? (() => nowTime),
    });

  const vectors =
    overrides.vectors ??
    (env.V_EVENTS
      ? env.V_EVENTS
      : ({
          query: () => Promise.reject(new Error("no V_EVENTS binding")),
          upsert: () => Promise.reject(new Error("no V_EVENTS binding")),
        } as Pick<VectorizeIndex, "query" | "upsert">));

  return {
    db: env.DB,
    vectors,
    models,
    now: overrides.now ?? (() => nowTime),
  };
}

export async function handleGroupBatch(
  batch: MessageBatch,
  env: PipelineEnv,
  overrides: GroupConsumerDeps = {},
): Promise<void> {
  // Invariant 1: sequential loop
  for (const msg of batch.messages as readonly Message<GroupMessage>[]) {
    const body = msg.body;
    if (body?.kind !== "group" || !body.articleId) {
      msg.ack();
      continue;
    }

    // Invariant 3: Safety flag off -> ack message, stage remains 'analyzed'
    if (!isEnabled(env, "MODEL_CALLS_ENABLED")) {
      msg.ack();
      continue;
    }

    const now = overrides.now ? overrides.now() : Date.now();
    const deps = defaultDeps(env, overrides, now);

    try {
      const result = await groupArticle(deps, body.articleId);
      if (result.status === "grouped" && env.Q_GENERATE) {
        await sendGenerate(env, [
          { kind: "artifacts", eventId: result.eventId },
          { kind: "evidence", eventId: result.eventId },
          { kind: "watch", eventId: result.eventId },
        ]);
      }
      msg.ack();
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        // Wait for budget without using up requeues: the article stays
        // `analyzed` and requeueStuck sends it again (as analyze.ts `touch`).
        await env.DB.prepare(
          `UPDATE articles SET stage_updated_at = ?2, requeue_count = 0
           WHERE id = ?1 AND stage = 'analyzed'`,
        )
          .bind(body.articleId, now)
          .run();
        console.warn({
          group: body.articleId,
          error: e.name,
          message: e.message,
        });
        msg.ack();
      } else if (
        e instanceof CallInProgressError ||
        e instanceof CallFailedError ||
        e instanceof CallUnknownError
      ) {
        console.warn({
          group: body.articleId,
          error: e.name,
          message: e.message,
        });
        msg.ack();
      } else {
        const error = e instanceof Error ? e.message : String(e);
        console.error({ queue: batch.queue, message: body, error });
        msg.retry();
      }
    }
  }
}
