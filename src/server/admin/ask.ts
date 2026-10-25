import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { sendGenerate } from "../../pipeline/messages";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listQuestions = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listQuestions(env.DB));

export const getQuestion = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      questionId: z.number().int().positive(),
    }),
  )
  .handler(async ({ data }) => {
    const q = await ops.getQuestion(env.DB, data.questionId);
    if (!q) {
      throw new Response("Question not found", { status: 404 });
    }
    return q;
  });

export const submitQuestion = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      question: z.string().min(3).max(1000),
      scopeType: z.enum(["event", "global"]).default("global"),
      eventId: z.number().int().positive().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const questionId = await ops.createQuestion(env.DB, data);
    await sendGenerate(env, [{ kind: "ask", questionId }]);
    return { questionId };
  });
