import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listPendingArtifacts = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listPendingArtifacts(env.DB));

export const decideArtifactReview = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    z.object({
      artifactId: z.number().int().positive(),
      decision: z.enum(["approved", "rejected"]),
      expectedRevision: z.number().int().nonnegative(),
    }),
  )
  .handler(async ({ data }) => {
    const success = await ops.reviewArtifact(env.DB, data);
    if (!success) {
      throw new Response(
        "Artifact review failed: version conflict or already decided",
        { status: 409 },
      );
    }
    return { success: true };
  });
