import { getDb } from "../server/db/client";
import { dlqMessages } from "../server/db/schema";
import type { PipelineEnv } from "./messages";

export async function persistDeadLetters(
  batch: MessageBatch,
  env: Pick<PipelineEnv, "DB">,
): Promise<void> {
  const db = getDb(env.DB);
  for (const msg of batch.messages) {
    const body = msg.body;
    const kind =
      typeof body === "object" &&
      body !== null &&
      "kind" in body &&
      typeof body.kind === "string"
        ? body.kind
        : null;
    await db
      .insert(dlqMessages)
      .values({
        id: msg.id,
        kind,
        bodyJson: JSON.stringify(body),
        attempts: msg.attempts,
        receivedAt: Date.now(),
        replayedAt: null,
      })
      .onConflictDoNothing({ target: dlqMessages.id });
    msg.ack();
  }
}
