import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

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
