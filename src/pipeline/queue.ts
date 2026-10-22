export async function runQueue(
  batch: MessageBatch,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log({ queue: batch.queue, messages: batch.messages.length });
  batch.ackAll();
}
