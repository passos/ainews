import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";
import { ingestCompanyFilings } from "../../pipeline/edgar/ingest";
import type { PipelineEnv } from "../../pipeline/messages";

export const listCompanies = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listCompanies(env.DB));

export const createCompany = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      cik: z.string().min(1).max(20),
      ticker: z.string().min(1).max(10),
      name: z.string().min(1).max(255),
    }),
  )
  .handler(async ({ data }) => {
    const companyId = await ops.createCompany(env.DB, data);
    return { companyId };
  });

export const toggleCompanyTracking = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      companyId: z.number().int().positive(),
      tracked: z.number().int().min(0).max(1),
    }),
  )
  .handler(async ({ data }) => {
    await ops.toggleCompanyTracking(env.DB, data.companyId, data.tracked);
    return { success: true };
  });

export const triggerPollCompany = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      companyId: z.number().int().positive(),
    }),
  )
  .handler(async ({ data }) => {
    const result = await ingestCompanyFilings(
      env as unknown as PipelineEnv,
      data.companyId,
      Date.now(),
    );
    return { success: true, ingestedCount: result.ingestedCount };
  });
