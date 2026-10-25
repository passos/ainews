import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";
import {
  draftIndustryConfig as draftIndustryConfigPipeline,
  type DraftIndustryResult,
} from "../../pipeline/discover/draft";

export type { DraftIndustryResult };

export const listIndustries = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listIndustries(env.DB));

export const getIndustry = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator((id: number) => id)
  .handler(async ({ data: id }) => ops.getIndustry(env.DB, id));

export const updateIndustryConfig = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    (data: {
      id: number;
      publishMode: "auto" | "review";
      primaryDomains: string[];
      config: string;
      disclaimer: string | null;
    }) => data,
  )
  .handler(async ({ data }) => ops.updateIndustryConfig(env.DB, data));

export const createIndustry = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    (data: {
      slug: string;
      name: string;
      publishMode: "auto" | "review";
      primaryDomains: string[];
      config: string;
      disclaimer: string | null;
    }) => data,
  )
  .handler(async ({ data }) => ops.createIndustry(env.DB, data));

export const draftIndustryConfig = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((data: { description: string; name?: string }) => data)
  .handler(async ({ data }) => {
    return draftIndustryConfigPipeline(
      {
        db: env.DB,
        env,
      },
      data,
    );
  });
