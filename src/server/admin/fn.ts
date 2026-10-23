// Rules for every admin server function (in src/server/admin/**):
// - Chain `.middleware([accessMiddleware])` directly on the server function
//   builder, written out in each file. No factory: the TanStack compiler finds
//   server functions by their literal call. tests/architecture.test.ts (R4)
//   checks this.
// - Writes use method "POST". GET only reads. The Origin check in
//   src/server/edge.ts runs only for methods other than GET/HEAD/OPTIONS.
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { adminOr403 } from "./access";

// Server function URLs (/_serverFn/...) do not start with /admin, so the edge
// path check does not cover them. This middleware does the same full check.
export const accessMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const admin = await adminOr403(getRequest(), env);
    return next({ context: { admin } });
  },
);
