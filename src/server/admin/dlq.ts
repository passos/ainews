import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listDlqMessages = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listDlqMessages(env.DB));

export const replayDlqMessage = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((messageId: string) => messageId)
  .handler(async ({ data: messageId }) =>
    ops.replayDlqMessage(
      env.DB,
      {
        qIngest: env.Q_INGEST,
        qGroup: env.Q_GROUP,
        qGenerate: env.Q_GENERATE,
      },
      messageId,
    ),
  );
