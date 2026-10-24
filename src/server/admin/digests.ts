import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listAdminDigests = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.listAdminDigests(env.DB));

export const publishDigest = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(z.object({ digestId: z.number().int().positive() }))
  .handler(async ({ data }) => {
    const success = await ops.publishDigest(env.DB, data.digestId);
    if (!success) {
      throw new Response("Digest already published or not found", {
        status: 400,
      });
    }
    return { success: true };
  });
