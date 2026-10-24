// Probe of the `write` slot (#43): sends the write request that analyze
// builds (buildWriteRequest + buildTextInput) for the first N real fixtures
// (tests/fixtures/analysis/real/*.json) and prints, per call, the thinking
// and answer tokens, finishReason and whether parseWriteOutput accepts the
// text. No ledger, no budget, no database.
// It costs about N x 4,000 output tokens x $3.75 per 1M tokens at most.
//
// Usage (this machine only, never in CI or `npm test`):
//   node --import ./scripts/ts-resolve.mjs scripts/probe-write.ts \
//     [--n 5] [--thinking '<json object>'] [--env-file /abs/.env.prod] \
//     [--dry-run]
//
// --thinking replaces WRITE_THINKING (prompts.ts) for this run, e.g.
//   --thinking '{"thinkingLevel":"low"}' or '{"thinkingBudget":256}'.
// Real run: the same env file and variables as scripts/try-analysis.ts
// (MODEL_CALLS_ENABLED=true, AI_GATEWAY_ID, CLOUDFLARE_API_TOKEN).
// --dry-run reads no env file and makes no network call: it prints the
// generationConfig and the size of each request.
import {
  buildWriteRequest,
  parseWriteOutput,
} from "../src/pipeline/analyze/prompts.ts";
import type { TextRequest } from "../src/providers/adapters.ts";
import {
  buildTextInput,
  parseTextOutput,
  record,
} from "../src/providers/adapters.ts";
import { costMicros } from "../src/providers/budget.ts";
import { DEFAULT_PRICES, DEFAULT_SLOTS } from "../src/providers/defaults.ts";
import { estimateTokens } from "../src/providers/jev.ts";
import type { ModelTransport } from "../src/providers/transport.ts";
import {
  describe,
  envFileArg,
  industryOf,
  loadFixtures,
  withBindingTransport,
} from "./trial.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const envFile = envFileArg(args);

function option(name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) {
    console.error(`${name} needs a value.`);
    process.exit(2);
  }
  return value;
}

const n = Number(option("--n") ?? "5");
if (!Number.isSafeInteger(n) || n <= 0) {
  console.error("--n must be a positive integer.");
  process.exit(2);
}

const thinkingArg = option("--thinking");
let thinking: Record<string, unknown> | undefined;
if (thinkingArg !== undefined) {
  try {
    thinking = record(JSON.parse(thinkingArg), "--thinking");
  } catch (error) {
    console.error(`--thinking must be a JSON object: ${describe(error)}`);
    process.exit(2);
  }
}

const { model } = DEFAULT_SLOTS.write;
const price = DEFAULT_PRICES[model];

/** The analyze write request of each fixture, with the --thinking override. */
function requests(): { file: string; request: TextRequest }[] {
  return loadFixtures()
    .slice(0, n)
    .map(({ file, fixture }) => {
      const request = buildWriteRequest(industryOf(fixture).analysis, {
        title: fixture.title,
        summary: fixture.summary,
        body: fixture.body,
        source: fixture.source,
      });
      return {
        file,
        request:
          thinking === undefined
            ? request
            : { ...request, thinkingConfig: thinking },
      };
    });
}

function dryRunAll(): number {
  for (const { file, request } of requests()) {
    const input = buildTextInput(model, request);
    const tokens = estimateTokens(input);
    const reserve = price
      ? costMicros(price, tokens, request.maxOutputTokens)
      : null;
    console.log(
      `${file}: generationConfig ${JSON.stringify(input.generationConfig)}, ` +
        `~${tokens} input tokens, reserve ${reserve ?? "?"} micro-USD`,
    );
  }
  console.log(`dry run ok (${model})`);
  return 0;
}

/** Token counts as the model reported them; the envelope is unwrapped. */
function usageMetadata(raw: unknown): Record<string, unknown> {
  const body = record(raw, "response");
  const inner =
    "state" in body && "result" in body ? record(body.result, "result") : body;
  return record(inner.usageMetadata, "usageMetadata");
}

async function runWith(transport: ModelTransport): Promise<number> {
  const list = requests();
  console.log(
    `model ${model}, thinkingConfig ${JSON.stringify(list[0]?.request.thinkingConfig ?? null)}`,
  );
  let micros = 0;
  let bad = 0;
  for (const { file, request } of list) {
    try {
      const raw = await transport.run(model, buildTextInput(model, request));
      const { text, usage, finishReason } = parseTextOutput(model, raw);
      const meta = usageMetadata(raw);
      const accepted = parseWriteOutput(text) !== null;
      const cost = price
        ? costMicros(price, usage.inputTokens, usage.outputTokens)
        : 0;
      micros += cost;
      if (finishReason !== "STOP" || !accepted) bad += 1;
      console.log(
        `${file}: thoughtsTokenCount ${String(meta.thoughtsTokenCount ?? 0)}, ` +
          `candidatesTokenCount ${String(meta.candidatesTokenCount ?? 0)}, ` +
          `finishReason ${finishReason ?? "?"}, ` +
          `parseWriteOutput ${accepted ? "ok" : "REJECTED"}, ${cost} micro-USD`,
      );
    } catch (error) {
      bad += 1;
      console.error(`${file}: ${describe(error)}`);
    }
  }
  console.log(
    `\n${list.length} calls, ${bad} not STOP+ok, cost ${micros} micro-USD (${model})`,
  );
  return bad === 0 ? 0 : 1;
}

process.exit(
  dryRun ? dryRunAll() : await withBindingTransport(envFile, runWith),
);
