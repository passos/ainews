// The only entry point for model calls. Every call goes through `call()`:
//
//   safety flag -> stored result? -> load slot -> build request + estimate
//     -> acquire lease -> batch(reserve budget + mark sent) -> transport
//     -> parse -> batch(settlement + ledger result)
//
// Anything that can fail on configuration or input runs before the lease.
//
// Slot configuration, prices, budget caps and tier reserves are read from
// `settings`. The client's tier sets the gateway floor (src/providers/tiers.ts).
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
  string,
} from "./adapters";
import type { TextRequest, Usage } from "./adapters";
import { costMicros, settle, utcDay } from "./budget";
import {
  DEFAULT_TIER_RESERVES,
  SETTING_BUDGET_CAPS,
  SETTING_PRICES,
  SETTING_SLOTS,
  SETTING_TIER_RESERVES,
} from "./defaults";
import type { Price, Slot, SlotConfig } from "./defaults";
import { buildJevInput, estimateTokens, parseJevOutput } from "./jev";
import { parseJinaText } from "./jina";
import type { JinaInput } from "./jina";
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
import { tierFloorMicros } from "./tiers";
import type { Tier, TierReserves } from "./tiers";
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
  readonly tier: Tier | undefined;
  constructor(channel: string, day: string, micros: number, tier?: Tier) {
    super(
      tier === undefined
        ? `budget ${channel} ${day} cannot cover ${micros} micro-USD`
        : `budget ${channel} ${day} tier ${tier} cannot cover ${micros} micro-USD`,
    );
    this.name = "BudgetExceededError";
    this.tier = tier;
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
  /** Gateway budget tier of every call of this client (CALL_TIERS). */
  tier: Tier;
}

const channelSchema = z.enum(["workers_ai", "gateway", "jina"]);
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
const reserveSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
/** `budget.tier_reserves`: exactly the keys "1".."4". */
export const tierReservesSchema = z
  .object({
    "1": reserveSchema,
    "2": reserveSchema,
    "3": reserveSchema,
    "4": reserveSchema,
  })
  .strict() satisfies z.ZodType<TierReserves>;

interface SlotSettings extends SlotConfig {
  price: Price;
  capMicros: number;
  tierReserves: TierReserves;
}

async function loadSlot(db: D1Database, slot: Slot): Promise<SlotSettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (?1, ?2, ?3, ?4)")
    .bind(
      SETTING_SLOTS,
      SETTING_PRICES,
      SETTING_BUDGET_CAPS,
      SETTING_TIER_RESERVES,
    )
    .all<{ key: string; value: string }>();
  const values = new Map(results.map((r) => [r.key, JSON.parse(r.value)]));
  const slots = slotsSchema.parse(values.get(SETTING_SLOTS) ?? {});
  const prices = pricesSchema.parse(values.get(SETTING_PRICES) ?? {});
  const caps = capsSchema.parse(values.get(SETTING_BUDGET_CAPS) ?? {});
  // Optional: without the row, the default reserves apply.
  const stored = values.get(SETTING_TIER_RESERVES);
  const tierReserves =
    stored === undefined
      ? DEFAULT_TIER_RESERVES
      : tierReservesSchema.parse(stored);
  const config = slots[slot];
  if (!config) throw new ModelConfigError(`slot ${slot} is not configured`);
  const price = prices[config.model];
  if (!price) throw new ModelConfigError(`no price for ${config.model}`);
  // A channel without a cap gets 0: fail-closed.
  return {
    ...config,
    price,
    capMicros: caps[config.channel] ?? 0,
    tierReserves,
  };
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
    // Tiers split the gateway channel only.
    const floorMicros =
      channel === "gateway"
        ? tierFloorMicros(config.tierReserves, options.tier)
        : 0;

    const outcome = await acquire(db, {
      logicalKey: key,
      slot,
      model,
      channel,
      now: now(),
      tier: options.tier,
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
        floorMicros,
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
      throw new BudgetExceededError(channel, day, estimated, options.tier);
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
    let usage: Usage;
    let actual: number;
    try {
      parsed = spec.parse(model, raw);
      usage = parsed.usage ?? {
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
      };
      // Negative or fractional usage makes costMicros throw: a bad response.
      actual = costMicros(price, usage.inputTokens, usage.outputTokens);
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

    /**
     * Jina Reader (`read` slot, fetch ladder rung 3). At most one call per
     * article per UTC day: a completed call is returned from the ledger.
     */
    readPage(url: string, articleId: number): Promise<PageRead> {
      return call({
        slot: "read",
        key: `jina:${articleId}:${utcDay(now())}`,
        build: (model) => {
          // Before acquire: a misconfigured slot never reaches a transport.
          if (!model.startsWith("jina/")) {
            throw new ModelConfigError(
              `slot read needs a jina/ model, got ${model}`,
            );
          }
          const input: JinaInput = { url };
          return { input, maxOutputTokens: READ_MAX_OUTPUT_TOKENS };
        },
        parse: (_model, raw) => parseRead(raw),
      });
    },

    /** `request.maxOutputTokens` must be a positive integer (RangeError). */
    async generateText(
      slot: "write" | "reason",
      key: string,
      request: TextRequest,
      validate?: (text: string) => void,
    ): Promise<{ text: string; usage: Usage; finishReason?: string }> {
      const { maxOutputTokens } = request;
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
        throw new RangeError(
          `maxOutputTokens must be a positive integer, got ${maxOutputTokens}`,
        );
      }
      return call({
        slot,
        key,
        build: (model) => ({
          input: buildTextInput(model, request),
          maxOutputTokens: request.maxOutputTokens,
        }),
        parse: (model, raw) => {
          const { text, usage, finishReason } = parseTextOutput(model, raw);
          if (validate) {
            validate(text);
          }
          return { value: { text, usage, finishReason }, usage };
        },
      });
    },
  };
}

export type ModelClient = ReturnType<typeof createModelClient>;

/**
 * Reservation of one Jina read: 40,000 tokens at the `jina/reader` price
 * ($0.05/1M) is 2,000 micro-USD.
 */
export const READ_MAX_OUTPUT_TOKENS = 40_000;

export interface PageRead {
  /** Null if Jina reports that the target page failed. */
  markdown: string | null;
  truncated: boolean;
}

/** `x-usage-tokens` is the output; without it the whole estimate is spent. */
function parseRead(raw: unknown): Parsed<PageRead> {
  const r = record(raw, "response");
  const tokens =
    r.usageTokens === null ? null : number(r.usageTokens, "usageTokens");
  return {
    value: {
      markdown: parseJinaText(string(r.text, "text")),
      truncated: r.truncated === true,
    },
    usage: { inputTokens: 0, outputTokens: tokens ?? READ_MAX_OUTPUT_TOKENS },
  };
}

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
