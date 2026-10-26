// Batch probe of the `write` and `reason` call sites (#117, AGENTS.md §4):
// one real request per site, built by scripts/probe-slots-lib.ts with the
// production prompt builders from tests/fixtures/analysis/real/*.json.
// Prints per site the finishReason, output and thinking tokens and the cost.
// No ledger, no budget, no database. The two discover sites are out of scope
// (see scripts/probe-slots-lib.ts).
//
// The requests are in three batches, each with an estimated max within
// PROBE_CAP_MICROS ($0.10, the limit in #117): B1 = the non-artifact sites,
// B2 and B3 = the artifact requests in two halves.
//
// Usage (this machine only, never in CI or `npm test`):
//   node --import ./scripts/ts-resolve.mjs scripts/probe-slots.ts --dry-run \
//     [--batch B1|B2|B3]
//   node --import ./scripts/ts-resolve.mjs scripts/probe-slots.ts \
//     --yes-spend --batch B1|B2|B3 [--env-file /abs/.env.prod] \
//     [--reject-dir /abs/dir] [--only id,id]
//
// --dry-run reads no env file and makes no network call: it prints the
// estimated maximum cost of each request, of each batch and of all batches.
// --yes-spend sends the requests of one batch, but refuses to start (before
// it reads the env file) when the batch's estimated max exceeds the cap. It
// stops at the first finishReason that is not STOP and exits 1. Same env file
// and variables as scripts/probe-write.ts (MODEL_CALLS_ENABLED=true,
// AI_GATEWAY_ID, CLOUDFLARE_API_TOKEN).
// --only (with --batch) sends just the listed site ids of that batch.
// When the production parser rejects a reply, the raw text and the zod issues
// go to <reject-dir>/<site id>.json (default: the system temp dir; a directory
// inside the repo is refused before anything is sent).
//
// Model ids: DEFAULT_SLOTS (src/providers/defaults.ts), as probe-write.ts.
// Production reads the `models.slots` setting, seeded with the same values.
// Prices: DEFAULT_PRICES (src/providers/defaults.ts, read from the model
// pages on 2026-10-22).
import type { TextRequest } from "../src/providers/adapters.ts";
import {
  buildTextInput,
  parseTextOutput,
  record,
} from "../src/providers/adapters.ts";
import { costMicros } from "../src/providers/budget.ts";
import { DEFAULT_PRICES, DEFAULT_SLOTS } from "../src/providers/defaults.ts";
import type { ModelTransport } from "../src/providers/transport.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSites,
  decide,
  FIXTURE_BODY_CHARS,
  outsideRepo,
  planSites,
  PROBE_CAP_MICROS,
  runBatch,
  saveRejection,
  splitBatches,
} from "./probe-slots-lib.ts";
import type { Batch, PlannedSite, ProbeResult } from "./probe-slots-lib.ts";
import { envFileArg, loadFixtures, withBindingTransport } from "./trial.ts";

const args = process.argv.slice(2);

function flagValue(flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

const plan = planSites(
  buildSites(loadFixtures()),
  DEFAULT_SLOTS,
  DEFAULT_PRICES,
);
const batches = splitBatches(plan);

function thinking(request: TextRequest): string {
  return JSON.stringify(request.thinkingConfig ?? null);
}

function capNote(totalMax: number): string {
  return totalMax <= PROBE_CAP_MICROS ? "within cap" : "OVER CAP";
}

function printPlan(shown: Batch[]): void {
  for (const b of shown) {
    console.log(
      `\n${b.name}\nsite | slot | model | thinkingConfig | maxOutputTokens | ~input tokens | max micro-USD`,
    );
    for (const site of b.sites) {
      console.log(
        [
          site.id,
          site.slot,
          site.model,
          thinking(site.request),
          site.request.maxOutputTokens,
          site.inputTokens,
          site.maxMicros,
        ].join(" | "),
      );
    }
    console.log(
      `${b.name}: ${b.sites.length} requests, estimated max ${b.totalMax} micro-USD, ` +
        `cap ${PROBE_CAP_MICROS} micro-USD (${capNote(b.totalMax)})`,
    );
  }
  if (shown.length > 1) {
    const requests = shown.reduce((n, b) => n + b.sites.length, 0);
    const total = shown.reduce((n, b) => n + b.totalMax, 0);
    console.log(
      `\nall batches: ${requests} requests, estimated max ${total} micro-USD ` +
        `(${shown.map((b) => `${b.name} ${b.totalMax}`).join(", ")})`,
    );
  }
  console.log(
    "\nmax = ceil((~input tokens x price.in + maxOutputTokens x price.out) / 1e6), " +
      "~input tokens = JSON length of the request / 3 (estimateTokens), " +
      `fixture bodies cut to ${FIXTURE_BODY_CHARS} chars.`,
  );
  const models = [...new Set(plan.map((s) => s.model))];
  for (const model of models) {
    const price = DEFAULT_PRICES[model];
    console.log(
      `price ${model}: in ${price.in}, out ${price.out} micro-USD per 1M tokens (DEFAULT_PRICES, src/providers/defaults.ts)`,
    );
  }
}

/** Token counts as the model reported them; the envelope is unwrapped. */
function usageMetadata(raw: unknown): Record<string, unknown> {
  const body = record(raw, "response");
  const inner =
    "state" in body && "result" in body ? record(body.result, "result") : body;
  return record(inner.usageMetadata, "usageMetadata");
}

async function probe(
  site: PlannedSite,
  transport: ModelTransport,
  rejectDir: string,
): Promise<ProbeResult> {
  const raw = await transport.run(
    site.model,
    buildTextInput(site.model, site.request),
  );
  const { text, usage, finishReason } = parseTextOutput(site.model, raw);
  const meta = usageMetadata(raw);
  const accepted = site.accepts(text);
  if (!accepted) {
    console.log(`rejected ${site.id}: ${saveRejection(rejectDir, site, text)}`);
  }
  return {
    finishReason: finishReason ?? "?",
    outputTokens: Number(meta.candidatesTokenCount ?? 0),
    thinkingTokens: Number(meta.thoughtsTokenCount ?? 0),
    cost: costMicros(
      DEFAULT_PRICES[site.model],
      usage.inputTokens,
      usage.outputTokens,
    ),
    accepted,
  };
}

async function main(): Promise<number> {
  const decision = decide(args, batches);
  switch (decision.kind) {
    case "usage":
      console.error(decision.message);
      return 2;
    case "dry":
      printPlan(decision.batches);
      console.log("dry run: nothing sent");
      return 0;
    case "refuse":
      console.error(`refused: ${decision.message}`);
      return 2;
    case "run": {
      printPlan([decision.batch]);
      const sites = decision.batch.sites;
      const rejectDir = outsideRepo(
        flagValue("--reject-dir") ?? join(tmpdir(), "probe-slots-rejections"),
      );
      return await withBindingTransport(envFileArg(args), (transport) =>
        runBatch(
          sites,
          (site) => probe(site, transport, rejectDir),
          (line) => console.log(line),
        ),
      );
    }
  }
}

process.exit(await main());
