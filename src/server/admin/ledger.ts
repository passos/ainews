import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { accessMiddleware } from "./fn";
import * as ops from "./ops";

export const listLedgerCalls = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .validator(
    (search?: { channel?: string; status?: string; page?: number }) => search,
  )
  .handler(async ({ data }) => ops.listLedgerCalls(env.DB, data));

export const getBudgetSummary = createServerFn({ method: "GET" })
  .middleware([accessMiddleware])
  .handler(async () => ops.getBudgetSummary(env.DB));

export const reconcileUnknownCall = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    (data: {
      callId: number;
      status: "completed" | "failed";
      costMicros?: number;
    }) => data,
  )
  .handler(async ({ data }) => ops.reconcileUnknownCall(env.DB, data));

export const updateDailyCap = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .validator(
    (data: { channel: "workers_ai" | "gateway" | "jina"; capMicros: number }) =>
      data,
  )
  .handler(async ({ data }) => ops.updateDailyCap(env.DB, data));
