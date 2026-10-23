import { createServerFn } from "@tanstack/react-start";
import { accessMiddleware } from "./fn";

export const getAdminIdentity = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async ({ context }) => ({ email: context.admin.email }));
