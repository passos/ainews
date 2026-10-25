import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listPendingClaims = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listPendingClaims(env.DB));

export const decideClaimReview = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      claimId: z.number().int().positive(),
      decision: z.enum(["approved", "rejected"]),
      expectedRevision: z.number().int().nonnegative(),
    }),
  )
  .handler(async ({ data }) => {
    const success = await ops.reviewClaim(env.DB, data);
    if (!success) {
      throw new Response(
        "Claim review failed: version conflict or already decided",
        { status: 409 },
      );
    }
    return { success: true };
  });
