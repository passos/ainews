export async function runScheduled(
  controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log({ cron: controller.cron });
}
