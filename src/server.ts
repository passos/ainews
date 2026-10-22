import handler from "@tanstack/react-start/server-entry";
import { runQueue } from "./pipeline/queue";
import { runScheduled } from "./pipeline/scheduled";

export default {
  fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
    return handler.fetch(request);
  },
  scheduled: runScheduled,
  queue: runQueue,
} satisfies ExportedHandler<Env>;
