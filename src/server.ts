import handler from "@tanstack/react-start/server-entry";
import { runQueue } from "./pipeline/queue";
import { runScheduled } from "./pipeline/scheduled";
import { handleFetch } from "./server/edge";

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return handleFetch(request, env, { handler: (r) => handler.fetch(r) });
  },
  scheduled: runScheduled,
  queue: runQueue,
} satisfies ExportedHandler<Env>;
