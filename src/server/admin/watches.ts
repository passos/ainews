import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listWatches = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listWatches(env.DB));

export const createWatch = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      slug: z
        .string()
        .min(2)
        .max(64)
        .regex(/^[a-z0-9-]+$/),
      question: z.string().min(5).max(500),
      criteria: z.string().min(5).max(1000),
      keywords: z.array(z.string().trim().min(1)).min(1),
      industryId: z.number().int().positive().nullable().optional(),
      status: z.enum(["active", "paused"]).default("active"),
    }),
  )
  .handler(async ({ data }) => {
    const watchId = await ops.createWatch(env.DB, data);
    return { watchId };
  });

export const updateWatch = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      id: z.number().int().positive(),
      question: z.string().min(5).max(500).optional(),
      criteria: z.string().min(5).max(1000).optional(),
      keywords: z.array(z.string().trim().min(1)).min(1).optional(),
      industryId: z.number().int().positive().nullable().optional(),
      status: z.enum(["active", "paused"]).optional(),
    }),
  )
  .handler(async ({ data }) => {
    await ops.updateWatch(env.DB, data);
    return { success: true };
  });

export const listWatchHits = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      watchId: z.number().int().positive(),
    }),
  )
  .handler(async ({ data }) => {
    return ops.listWatchHits(env.DB, data.watchId);
  });

export const listPendingWatchHits = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listPendingWatchHits(env.DB));

export const decideWatchHitReview = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      hitId: z.number().int().positive(),
      decision: z.enum(["approved", "rejected"]),
    }),
  )
  .handler(async ({ data }) => {
    const success = await ops.reviewWatchHit(env.DB, data);
    if (!success) {
      throw new Response("Watch hit review failed: already decided", {
        status: 409,
      });
    }
    return { success: true };
  });
