import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accessMiddleware } from "./fn";
import { contentDisplaySchema } from "../../lib/content-display";
import { isEnabled } from "../../lib/flags";
import * as ops from "./ops";

const sourceFields = z.object({
  name: z.string().trim().min(1),
  feedUrl: z.string().trim().url(),
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
  contentDisplay: contentDisplaySchema.optional(),
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

export const listSourceCandidates = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator((search?: { industryId?: number; status?: string }) => search)
  .handler(async ({ data }) => ops.listSourceCandidates(env.DB, data));

export const approveCandidate = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((id: number) => id)
  .handler(async ({ data: id }) => ops.approveCandidate(env.DB, id));

export const rejectCandidate = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((data: { id: number; reason?: string }) => data)
  .handler(async ({ data }) => ops.rejectCandidate(env.DB, data));

export const triggerDiscovery = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator((data: { industryId: number; queries?: string[] }) => data)
  .handler(async ({ data }) => {
    if (!isEnabled(env, "DISCOVERY_ENABLED")) {
      throw new Response("Discovery is disabled (DISCOVERY_ENABLED is false)", {
        status: 400,
      });
    }
    return ops.triggerDiscovery(env.DB, env.Q_GENERATE, data);
  });
