import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { fundingCorrectionSchema } from "../../lib/funding/types";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listPendingFundingRounds = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listPendingFundingRounds(env.DB));

export const decideFundingRound = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      roundId: z.number().int().positive(),
      decision: z.enum(["published", "rejected"]),
    }),
  )
  .handler(async ({ data }) => ({
    updated: await ops.decideFundingRound(env.DB, data.roundId, data.decision),
  }));

export const correctFundingRound = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(fundingCorrectionSchema)
  .handler(async ({ data }) => ({
    updated: await ops.correctFundingRound(env.DB, data),
  }));
