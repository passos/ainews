import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

const sourceFields = z.object({
  name: z.string().trim().min(1),
  feedUrl: z.string().url(),
  siteDomain: z.string().trim().min(1).nullable().default(null),
  intervalMinutes: z.number().int().positive().default(60),
  utcOffset: z
    .string()
    .regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/)
    .default("+00:00"),
  config: z.string().default("{}"),
  jinaEnabled: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform(Number)
    .default(0),
});

export const listSources = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator((search?: { industryId?: number; status?: string }) => search)
  .handler(async ({ data }) => ops.listSources(env.DB, data));

export const getSource = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator((id: number) => id)
  .handler(async ({ data: id }) => ops.getSource(env.DB, id));

export const createSource = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    sourceFields.extend({
      industryId: z.number().int().positive(),
      kind: z.enum(["rss", "html"]),
    }),
  )
  .handler(async ({ data }) => ops.createSource(env.DB, data));

export const updateSource = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(sourceFields.extend({ id: z.number().int().positive() }))
  .handler(async ({ data }) => ops.updateSource(env.DB, data));

export const deleteSource = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((id: number) => id)
  .handler(async ({ data: id }) => ops.deleteSource(env.DB, id));

export const resumeSource = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((id: number) => id)
  .handler(async ({ data: id }) => ops.resumeSource(env.DB, id));

export const triggerCollect = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((id: number) => id)
  .handler(async ({ data: id }) => ops.triggerCollect(env.Q_INGEST, id));
