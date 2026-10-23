// The only entry point for model calls. Every call goes through `call()`:
//
//   safety flag -> stored result? -> load slot -> build request + estimate
//     -> acquire lease -> batch(reserve budget + mark sent) -> transport
//     -> parse -> batch(settlement + ledger result)
//
// Anything that can fail on configuration or input runs before the lease.
//
// Slot configuration, prices and budget caps are read from `settings`.
// Tests inject a fake transport; nothing here touches env.AI directly.
import { z } from "zod";
import { isEnabled } from "../lib/flags";
import type { SafetyFlag } from "../lib/flags";
import {
  buildTextInput,
  number,
  parseTextOutput,
  record,
  array,
} from "./adapters";
import type { TextRequest, Usage } from "./adapters";
import { costMicros, settle, utcDay } from "./budget";
import { SETTING_BUDGET_CAPS, SETTING_PRICES, SETTING_SLOTS } from "./defaults";
import type { Price, Slot, SlotConfig } from "./defaults";
import { buildJevInput, estimateTokens, parseJevOutput } from "./jev";
import type { JevAnswers, JevQuestions, JevState } from "./jev";
import {
  abandon,
  acquire,
  complete,
  fail,
  findCompleted,
  reserveAndMarkSent,
} from "./ledger";
import type { SendOutcome } from "./ledger";
import type { ModelTransport } from "./transport";

export class ModelCallsDisabledError extends Error {
  constructor() {
    super("MODEL_CALLS_ENABLED is off");
    this.name = "ModelCallsDisabledError";
  }
}

/** Another caller holds a live lease on this key. Retry later. */
export class CallInProgressError extends Error {
  constructor(key: string) {
    super(`model call ${key} is in progress`);
    this.name = "CallInProgressError";
  }
}

export class BudgetExceededError extends Error {
  constructor(channel: string, day: string, micros: number) {
    super(`budget ${channel} ${day} cannot cover ${micros} micro-USD`);
    this.name = "BudgetExceededError";
  }
}

/** Sent but never recorded. Not resent; reconciled by the admin (#9). */
export class CallUnknownError extends Error {
  constructor(key: string) {
    super(`model call ${key} has an unknown outcome`);
    this.name = "CallUnknownError";
  }
}

/** Out of attempts. */
export class CallFailedError extends Error {
  constructor(key: string, reason: string | null) {
    super(`model call ${key} failed: ${reason ?? "unknown error"}`);
    this.name = "CallFailedError";
  }
}

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

export interface ModelClientOptions {
  db: D1Database;
  transport: ModelTransport;
  /** Only read for the MODEL_CALLS_ENABLED safety flag. */
  env: Partial<Record<SafetyFlag, string | undefined>>;
  now?: () => number;
}

const channelSchema = z.enum(["workers_ai", "gateway"]);
const slotsSchema = z.record(
  z.string(),
  z.object({ model: z.string().min(1), channel: channelSchema }),
);
const pricesSchema = z.record(
  z.string(),
  z.object({
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
  }),
);
const capsSchema = z.record(z.string(), z.number().int().nonnegative());

interface SlotSettings extends SlotConfig {
  price: Price;
  capMicros: number;
}

async function loadSlot(db: D1Database, slot: Slot): Promise<SlotSettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (?1, ?2, ?3)")
    .bind(SETTING_SLOTS, SETTING_PRICES, SETTING_BUDGET_CAPS)
    .all<{ key: string; value: string }>();
  const values = new Map(results.map((r) => [r.key, JSON.parse(r.value)]));
  const slots = slotsSchema.parse(values.get(SETTING_SLOTS) ?? {});
  const prices = pricesSchema.parse(values.get(SETTING_PRICES) ?? {});
  const caps = capsSchema.parse(values.get(SETTING_BUDGET_CAPS) ?? {});
  const config = slots[slot];
  if (!config) throw new ModelConfigError(`slot ${slot} is not configured`);
  const price = prices[config.model];
  if (!price) throw new ModelConfigError(`no price for ${config.model}`);
  // A channel without a cap gets 0: fail-closed.
  return { ...config, price, capMicros: caps[config.channel] ?? 0 };
}

interface Parsed<T> {
  value: T;
  /** Null: the response has no usage; settle at the estimate. */
  usage: Usage | null;
}

interface CallSpec<T> {
  slot: Slot;
  key: string;
  build(model: string): { input: unknown; maxOutputTokens: number };
  parse(model: string, raw: unknown): Parsed<T>;
}

export function createModelClient(options: ModelClientOptions) {
  const { db, transport, env } = options;
  const now = options.now ?? Date.now;

  async function call<T>(spec: CallSpec<T>): Promise<T> {
    const { slot, key } = spec;
    // First, before any DB write.
    if (!isEnabled(env, "MODEL_CALLS_ENABLED")) {
      throw new ModelCallsDisabledError();
    }

    const stored = await findCompleted(db, key);
    if (stored) {
      return spec.parse(stored.model, JSON.parse(stored.responseJson)).value;
    }

    const config = await loadSlot(db, slot);
    const { model, channel, price } = config;
    // Before acquire: an error here leaves no row behind.
    const { input, maxOutputTokens } = spec.build(model);
    const requestJson = JSON.stringify(input);
    const estimatedInputTokens = estimateTokens(input);
    const estimated = costMicros(price, estimatedInputTokens, maxOutputTokens);

    const outcome = await acquire(db, {
      logicalKey: key,
      slot,
      model,
      channel,
      now: now(),
    });
    switch (outcome.kind) {
      case "completed":
        return spec.parse(outcome.model, JSON.parse(outcome.responseJson))
          .value;
      case "in_progress":
        throw new CallInProgressError(key);
      case "unknown":
        throw new CallUnknownError(key);
      case "exhausted":
        throw new CallFailedError(key, outcome.error);
    }
    const { attempt } = outcome;
    const day = utcDay(now());

    let send: SendOutcome;
    try {
      send = await reserveAndMarkSent(db, {
        logicalKey: key,
        attempt,
        now: now(),
        requestJson,
        estimatedMicros: estimated,
        budgetDay: day,
        channel,
        capMicros: config.capMicros,
      });
    } catch (error) {
      // Nothing was reserved or sent, or the batch did commit and the row
      // becomes `unknown` later. If this write fails too, the lease expires
      // and the next acquire takes over; the first error is the useful one.
      await abandon(db, {
        logicalKey: key,
        attempt,
        now: now(),
        error: describe(error),
      })
        .run()
        .catch(() => undefined);
      throw error;
    }
    if (send === "over_budget") {
      throw new BudgetExceededError(channel, day, estimated);
    }
    if (send === "lost") throw new CallInProgressError(key);

    // From here on the call holds a reservation of `estimated`.
    const charge = (actualMicros: number) =>
      settle(db, {
        logicalKey: key,
        attempt,
        day,
        channel,
        reservedMicros: estimated,
        actualMicros,
      });

    let raw: unknown;
    try {
      raw = await transport.run(model, input);
    } catch (error) {
      // A timeout or a lost connection does not prove the model did not run
      // and bill. Count the estimate as spent; the row can be retried.
      await db.batch([
        charge(estimated),
        fail(db, {
          logicalKey: key,
          attempt,
          now: now(),
          error: describe(error),
          responseJson: null,
          costMicros: estimated,
        }),
      ]);
      throw error;
    }

    const responseJson = JSON.stringify(raw ?? null);
    let parsed: Parsed<T>;
    try {
      parsed = spec.parse(model, raw);
    } catch (error) {
      // The request was billed: count the estimate as spent.
      await db.batch([
        charge(estimated),
        fail(db, {
          logicalKey: key,
          attempt,
          now: now(),
          error: `parse: ${describe(error)}`,
          responseJson,
          costMicros: estimated,
        }),
      ]);
      throw error;
    }

    const usage = parsed.usage ?? {
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
    };
    const actual = costMicros(price, usage.inputTokens, usage.outputTokens);
    await db.batch([
      charge(actual),
      complete(db, {
        logicalKey: key,
        attempt,
        now: now(),
        responseJson,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros: actual,
      }),
    ]);
    return parsed.value;
  }

  return {
    /** Jev questions about `state`; `state.body` is truncated to fit. */
    judge<Q extends JevQuestions>(
      key: string,
      state: JevState,
      questions: Q,
    ): Promise<JevAnswers<Q>> {
      return call({
        slot: "judge",
        key,
        build: () => ({
          input: buildJevInput(state, questions),
          maxOutputTokens: 0,
        }),
        parse: (_model, raw) => {
          const { answers, usage } = parseJevOutput(questions, raw);
          return { value: answers, usage };
        },
      });
    },

    /** One vector per text. Assumption: `{ text }` in, `data` out. */
    embed(key: string, texts: string[]): Promise<number[][]> {
      return call({
        slot: "embed",
        key,
        build: () => ({ input: { text: texts }, maxOutputTokens: 0 }),
        parse: (_model, raw) => ({ value: parseEmbedding(raw), usage: null }),
      });
    },

    generateText(
      slot: "write" | "reason",
      key: string,
      request: TextRequest,
    ): Promise<{ text: string; usage: Usage }> {
      return call({
        slot,
        key,
        build: (model) => ({
          input: buildTextInput(model, request),
          maxOutputTokens: request.maxOutputTokens,
        }),
        parse: (model, raw) => {
          const { text, usage } = parseTextOutput(model, raw);
          return { value: { text, usage }, usage };
        },
      });
    },
  };
}

export type ModelClient = ReturnType<typeof createModelClient>;

function parseEmbedding(raw: unknown): number[][] {
  return array(record(raw, "response").data, "data").map((row, i) =>
    array(row, `data[${i}]`).map((x, j) => number(x, `data[${i}][${j}]`)),
  );
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
