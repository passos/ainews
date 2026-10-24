import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listPendingArticles = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator((search?: { industryId?: number }) => search)
  .handler(async ({ data }) => ops.listPendingArticles(env.DB, data));

export const decideReview = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    (data: {
      articleId: number;
      bodySha: string;
      decision: "approved" | "rejected";
    }) => data,
  )
  .handler(async ({ data, context }) =>
    ops.decideReview(env.DB, { ...data, reviewer: context.admin.email }),
  );

export const listStuckArticles = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listStuckArticles(env.DB));
