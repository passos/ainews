// Real model calls for every slot, over both transports. This is the only
// way to confirm the Unified Billing request formats (#3). It costs a little
// money. It does not use the ledger or the budget.
//
// Usage (env file path is up to the caller):
//   AI_GATEWAY_ID=ainews node --env-file=/abs/path/.env.prod scripts/smoke-models.ts
//
// Needs CF_AI_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
//   REST path:    restTransport with CF_AI_API_TOKEN.
//   Binding path: getPlatformProxy() on the top-level wrangler.jsonc config
//                 (env.test has no AI binding). Wrangler auth:
//                 SMOKE_BINDING_AUTH=token (default) sets
//                 CLOUDFLARE_API_TOKEN=$CF_AI_API_TOKEN;
//                 SMOKE_BINDING_AUTH=deploy keeps CLOUDFLARE_API_TOKEN as the
//                 caller set it (the ainews-deploy token) and requires it;
//                 SMOKE_BINDING_AUTH=login removes CLOUDFLARE_API_TOKEN, so
//                 wrangler uses the `wrangler login` session.
// Tokens are never printed.
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
// Explicit extensions: Node resolves these files directly.
import { buildTextInput, parseTextOutput } from "../src/providers/adapters.ts";
import type { Usage } from "../src/providers/adapters.ts";
import { costMicros } from "../src/providers/budget.ts";
import { DEFAULT_PRICES, DEFAULT_SLOTS } from "../src/providers/defaults.ts";
import type { Slot } from "../src/providers/defaults.ts";
import { buildJevInput, estimateTokens } from "../src/providers/jev.ts";
import { parseJevOutput } from "../src/providers/jev.ts";
import {
  TransportHttpError,
  bindingTransport,
  restTransport,
} from "../src/providers/transport.ts";
import type { ModelTransport } from "../src/providers/transport.ts";

const RAW_LIMIT = 2_000;
// `read` (Jina Reader) is checked by scripts/smoke-body.ts.
type SmokeSlot = Exclude<Slot, "read">;
const SLOTS: SmokeSlot[] = ["judge", "embed", "write", "reason"];
const CONFIG_PATH = fileURLToPath(
  new URL("../wrangler.jsonc", import.meta.url),
);

type Path = "rest" | "binding";

interface Outcome {
  slot: SmokeSlot;
  path: Path;
  ok: boolean;
  detail: string;
  gatewayMetadata: unknown;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}.`);
    process.exit(2);
  }
  return value;
}

const gatewayId = required("AI_GATEWAY_ID");
const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const aiToken = required("CF_AI_API_TOKEN");
const bindingAuth = process.env.SMOKE_BINDING_AUTH ?? "token";
if (
  bindingAuth !== "token" &&
  bindingAuth !== "deploy" &&
  bindingAuth !== "login"
) {
  console.error('SMOKE_BINDING_AUTH must be "token", "deploy" or "login".');
  process.exit(2);
}
if (bindingAuth === "deploy") required("CLOUDFLARE_API_TOKEN");

// Neutral smoke inputs, not product prompts (those start in #7).
const JEV_QUESTIONS = {
  aboutWeather: {
    type: "noul",
    instructions: "Is the text about the weather?",
  },
  topic: {
    type: "choice",
    instructions: "What is the main topic of the text?",
    criteria: { weather: "The weather", sports: "Sports" },
  },
  clarity: {
    type: "score",
    instructions: "How clear is the text?",
    criteria: ["unclear", "somewhat clear", "clear"],
  },
} as const;

function buildInput(slot: SmokeSlot, model: string) {
  switch (slot) {
    case "judge":
      return {
        input: buildJevInput(
          { title: "Smoke test", body: "It is sunny and warm today." },
          JEV_QUESTIONS,
        ),
        maxOutputTokens: 0,
      };
    case "embed":
      return { input: { text: ["smoke test"] }, maxOutputTokens: 0 };
    case "write":
    case "reason":
      return {
        input: buildTextInput(model, {
          system: "Answer with one word.",
          prompt: "Say OK.",
          maxOutputTokens: 256,
        }),
        maxOutputTokens: 256,
      };
  }
}

function parse(
  slot: SmokeSlot,
  model: string,
  raw: unknown,
): {
  value: unknown;
  usage: Usage | null;
} {
  switch (slot) {
    case "judge": {
      const { answers, usage } = parseJevOutput(JEV_QUESTIONS, raw);
      return { value: answers, usage };
    }
    case "embed": {
      const data = (raw as { data?: unknown }).data;
      if (!Array.isArray(data) || !Array.isArray(data[0])) {
        throw new Error("embed: no data[][] in the response");
      }
      return {
        value: { vectors: data.length, dimensions: data[0].length },
        usage: null,
      };
    }
    case "write":
    case "reason": {
      const { text, usage } = parseTextOutput(model, raw);
      return { value: { text }, usage };
    }
  }
}

/** Finds the first `gatewayMetadata` object anywhere in the response. */
function findGatewayMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6 || typeof value !== "object" || value === null) return null;
  if ("gatewayMetadata" in value) {
    return (value as { gatewayMetadata: unknown }).gatewayMetadata;
  }
  for (const child of Object.values(value)) {
    const found = findGatewayMetadata(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof TransportHttpError) {
    return `HTTP ${error.status}: ${error.body.slice(0, RAW_LIMIT)}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

async function runOne(
  path: Path,
  slot: SmokeSlot,
  transport: ModelTransport,
  rawText: () => string | null,
  extra: () => Record<string, unknown>,
): Promise<Outcome> {
  const { model, channel } = DEFAULT_SLOTS[slot];
  const price = DEFAULT_PRICES[model];
  console.log(`\n=== ${slot} via ${path}: ${model} (channel ${channel})`);
  try {
    const { input, maxOutputTokens } = buildInput(slot, model);
    console.log("request:", JSON.stringify(input));
    console.log(
      `estimate: ${estimateTokens(input)} input tokens, ${maxOutputTokens} max output tokens`,
    );

    let raw: unknown;
    try {
      raw = await transport.run(model, input);
    } finally {
      for (const [key, value] of Object.entries(extra())) {
        console.log(`${key}:`, value);
      }
    }
    const text = rawText() ?? JSON.stringify(raw);
    console.log(`raw response (first ${RAW_LIMIT} chars):`);
    console.log(text.slice(0, RAW_LIMIT));
    const gatewayMetadata = findGatewayMetadata(raw);
    console.log("gatewayMetadata:", JSON.stringify(gatewayMetadata));

    const parsed = parse(slot, model, raw);
    console.log("parsed:", JSON.stringify(parsed.value));
    console.log("usage:", JSON.stringify(parsed.usage));
    const usage = parsed.usage ?? {
      inputTokens: estimateTokens(input),
      outputTokens: 0,
    };
    const micros = price
      ? costMicros(price, usage.inputTokens, usage.outputTokens)
      : null;
    console.log(
      `cost: ${micros ?? "no price"} micro-USD${parsed.usage ? "" : " (usage missing, from estimate)"}`,
    );
    return {
      slot,
      path,
      ok: true,
      detail: `${micros ?? "?"} micro-USD`,
      gatewayMetadata,
    };
  } catch (error) {
    const detail = describeError(error);
    console.log(`FAIL: ${detail}`);
    return { slot, path, ok: false, detail, gatewayMetadata: null };
  }
}

async function runRest(): Promise<Outcome[]> {
  let lastRaw: string | null = null;
  let lastHeaders: Record<string, string> = {};
  const capture: typeof fetch = async (input, init) => {
    lastRaw = null;
    lastHeaders = {};
    const response = await fetch(input, init);
    lastRaw = await response.clone().text();
    // AI Gateway response headers only; request headers are never printed.
    for (const [key, value] of response.headers) {
      if (key.startsWith("cf-aig-")) lastHeaders[key] = value;
    }
    return response;
  };
  const transport = restTransport({
    accountId,
    token: aiToken,
    gatewayId,
    fetch: capture,
  });
  const outcomes: Outcome[] = [];
  for (const slot of SLOTS) {
    outcomes.push(
      await runOne(
        "rest",
        slot,
        transport,
        () => lastRaw,
        () => ({ "response cf-aig-* headers": JSON.stringify(lastHeaders) }),
      ),
    );
  }
  return outcomes;
}

async function runBinding(): Promise<Outcome[]> {
  if (bindingAuth === "token") {
    process.env.CLOUDFLARE_API_TOKEN = aiToken;
  } else if (bindingAuth === "login") {
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
  // "deploy": CLOUDFLARE_API_TOKEN stays as the caller set it.
  console.log(`\nbinding auth: ${bindingAuth}, config ${CONFIG_PATH}`);

  let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ AI: Ai }>>>;
  try {
    proxy = await getPlatformProxy<{ AI: Ai }>({
      configPath: CONFIG_PATH,
      persist: false,
    });
  } catch (error) {
    const detail = `getPlatformProxy: ${describeError(error)}`;
    console.log(`FAIL: ${detail}`);
    return SLOTS.map((slot) => ({
      slot,
      path: "binding" as const,
      ok: false,
      detail,
      gatewayMetadata: null,
    }));
  }

  const outcomes: Outcome[] = [];
  try {
    const ai = proxy.env.AI;
    const transport = bindingTransport(ai, gatewayId);
    for (const slot of SLOTS) {
      outcomes.push(
        await runOne(
          "binding",
          slot,
          transport,
          () => null,
          () => ({ aiGatewayLogId: ai.aiGatewayLogId }),
        ),
      );
    }
  } finally {
    await proxy.dispose();
  }
  return outcomes;
}

function printSummary(outcomes: Outcome[]): void {
  console.log("\n=== summary");
  const header = ["slot", "path", "result", "channel", "gatewayMetadata"];
  const rows = outcomes.map((o) => [
    o.slot,
    o.path,
    o.ok ? `ok (${o.detail})` : "fail",
    DEFAULT_SLOTS[o.slot].channel,
    JSON.stringify(o.gatewayMetadata),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  for (const row of [header, ...rows]) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
  }
}

const outcomes = [...(await runRest()), ...(await runBinding())];
printSummary(outcomes);
process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
