// Local stand-ins for AI Gateway and Workers AI. Tests never reach a real
// service: the model client only sees this transport, and restTransport
// only sees `fakeFetch`.
import { env } from "cloudflare:workers";
import type { ModelTransport } from "../../src/providers/transport";
import { fixtureFor } from "./fixtures";

export interface FakeTransport extends ModelTransport {
  calls: { model: string; input: unknown }[];
}

/** Answers with the model page fixture unless `respond` is given. */
export function fakeTransport(
  respond: (model: string, input: unknown) => unknown = fixtureFor,
): FakeTransport {
  const calls: FakeTransport["calls"] = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      // Yield, so concurrent callers interleave as they would over the network.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return respond(model, input);
    },
  };
}

export interface FakeFetch {
  fetch: typeof fetch;
  requests: Request[];
}

export function fakeFetch(respond: () => Response): FakeFetch {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return respond();
    },
  };
}

export const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
export const TODAY = "2026-10-22";
export const ENABLED = { MODEL_CALLS_ENABLED: "true" };

/** Empties the ledger and budgets, then gives each channel `capMicros`. */
export async function resetLedger(capMicros = 1_000_000): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_calls"),
    env.DB.prepare("DELETE FROM budgets"),
    env.DB.prepare(
      "INSERT INTO budgets (day, channel, cap_micros) VALUES (?1, 'workers_ai', ?2), (?1, 'gateway', ?2)",
    ).bind(TODAY, capMicros),
  ]);
}

export async function budgetRow(channel: string) {
  return env.DB.prepare(
    "SELECT cap_micros, reserved_micros, spent_micros FROM budgets WHERE day = ?1 AND channel = ?2",
  )
    .bind(TODAY, channel)
    .first<{
      cap_micros: number;
      reserved_micros: number;
      spent_micros: number;
    }>();
}

export async function ledgerRow(key: string) {
  return env.DB.prepare(
    `SELECT status, attempt, failures, sent_at, error, cost_micros,
       estimated_micros, budget_day FROM llm_calls WHERE logical_key = ?1`,
  )
    .bind(key)
    .first<{
      status: string;
      attempt: number;
      failures: number;
      sent_at: number | null;
      error: string | null;
      cost_micros: number | null;
      estimated_micros: number | null;
      budget_day: string | null;
    }>();
}

/**
 * env.DB, with `hook` around every batch(). `n` counts batches from 1; call
 * `run` to execute the real batch, or throw instead. Methods are bound to the
 * real binding (it has private fields).
 */
export function hookBatch(
  hook: (n: number, run: () => Promise<D1Result[]>) => Promise<D1Result[]>,
): D1Database {
  let n = 0;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          n += 1;
          return hook(n, () => target.batch(statements));
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
