import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const getArticle = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator((id: number) => id)
  .handler(async ({ data: id }) => ops.getArticle(env.DB, id));

export const updateArticleOverride = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    (data: {
      articleId: number;
      titleOverride?: string | null;
      summaryOverride?: string | null;
    }) => data,
  )
  .handler(async ({ data }) => ops.updateArticleOverride(env.DB, data));

export const changeArticleIndustry = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((data: { articleId: number; industryId: number }) => data)
  .handler(async ({ data }) => ops.changeArticleIndustry(env.DB, data));

export const reanalyzeArticle = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((data: { articleId: number; expectedStage: string }) => data)
  .handler(async ({ data }) =>
    ops.reanalyzeArticle(env.DB, env.Q_INGEST, data),
  );

export const retractArticle = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((articleId: number) => articleId)
  .handler(async ({ data: articleId, context }) =>
    ops.retractArticle(env.DB, articleId, context.admin.email),
  );

export const createCorrection = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    (data: { targetType: string; targetId: number; body: string }) => data,
  )
  .handler(async ({ data }) => ops.createCorrection(env.DB, data));
