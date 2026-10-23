// Trial run of the analysis on the real fixtures (tests/fixtures/analysis/
// real/*.json), for the owner to check the seed criteria and thresholds (#8).
// Jev only (the `judge` slot): no `write`, no ledger, no budget, no database.
// It costs about 10 articles x 10,000 tokens x $0.042 per 1M tokens.
//
// Usage (this machine only, never in CI or `npm test`):
//   node --import ./scripts/ts-resolve.mjs scripts/try-analysis.ts \
//     [--env-file /abs/path/.env.prod] [--dry-run]
//
// Real run: loads the env file (default .env.prod; variables that are already
// set win), needs MODEL_CALLS_ENABLED=true, AI_GATEWAY_ID and
// CLOUDFLARE_API_TOKEN (the ainews-deploy token that wrangler uses for the AI
// binding), as the binding path of scripts/smoke-models.ts does.
// Tokens are never printed.
//
// --dry-run reads no env file and makes no network call. It builds the Jev
// input of every fixture, checks it against the official input schema
// (tests/fixtures/jev/schema-input.json) and prints the size.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";
import { getPlatformProxy } from "wrangler";
import { isEnabled } from "../src/lib/flags.ts";
import { buildAnalysisRequest } from "../src/pipeline/analyze/questions.ts";
import { labelValue } from "../src/pipeline/analyze/labels.ts";
import { scoreAnalysis } from "../src/pipeline/analyze/score.ts";
import type { AnalysisAnswers } from "../src/pipeline/analyze/score.ts";
import { DIMS } from "../src/pipeline/analyze/config.ts";
import { costMicros } from "../src/providers/budget.ts";
import { DEFAULT_PRICES, DEFAULT_SLOTS } from "../src/providers/defaults.ts";
import {
  buildJevInput,
  estimateTokens,
  parseJevOutput,
} from "../src/providers/jev.ts";
import {
  bindingTransport,
  TransportHttpError,
} from "../src/providers/transport.ts";
import type { ModelTransport } from "../src/providers/transport.ts";
import { SEED_INDUSTRIES } from "../src/server/db/seed/industries.ts";
import { realFixture } from "../tests/fixtures/analysis/real-shape.ts";
import type { RealFixture } from "../tests/fixtures/analysis/real-shape.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const envFileAt = args.indexOf("--env-file");
const envFile = envFileAt >= 0 ? args[envFileAt + 1] : ".env.prod";
if (envFileAt >= 0 && !envFile) {
  console.error("--env-file needs a path.");
  process.exit(2);
}

const CONFIG_PATH = fileURLToPath(
  new URL("../wrangler.jsonc", import.meta.url),
);
const FIXTURES = fileURLToPath(
  new URL("../tests/fixtures/analysis/real/", import.meta.url),
);
const SCHEMA = fileURLToPath(
  new URL("../tests/fixtures/jev/schema-input.json", import.meta.url),
);

function loadFixtures(): { file: string; fixture: RealFixture }[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      fixture: realFixture.parse(
        JSON.parse(readFileSync(FIXTURES + file, "utf8")),
      ),
    }));
}

/** The request as sent: questions of the seeded industry + the fixture. */
function build(fixture: RealFixture) {
  const industry = SEED_INDUSTRIES.find((i) => i.slug === fixture.industry);
  if (!industry) throw new Error(`unknown industry ${fixture.industry}`);
  const { state, questions } = buildAnalysisRequest(
    {
      title: fixture.title,
      summary: fixture.summary,
      publishedAt: Date.parse(fixture.published_at),
    },
    { name: fixture.source },
    { name: industry.name, analysis: industry.analysis },
    fixture.body,
  );
  return { industry, questions, input: buildJevInput(state, questions) };
}

function dryRunAll(): number {
  const validator = new Validator(
    JSON.parse(readFileSync(SCHEMA, "utf8")),
    "2020-12",
    false,
  );
  let bad = 0;
  for (const { file, fixture } of loadFixtures()) {
    try {
      const { input } = build(fixture);
      const valid = validator.validate(JSON.parse(JSON.stringify(input)));
      if (!valid.valid) bad += 1;
      console.log(
        `${file}: ${Object.keys(input.questions).length} questions, ` +
          `${JSON.stringify(input).length} chars, ` +
          `~${estimateTokens(input)} tokens, schema ${valid.valid ? "ok" : "FAIL"}`,
      );
      if (!valid.valid) console.log(JSON.stringify(valid.errors.slice(0, 3)));
    } catch (error) {
      bad += 1;
      console.log(`${file}: ${describe(error)}`);
    }
  }
  console.log(bad === 0 ? "dry run ok" : `dry run: ${bad} failed`);
  return bad === 0 ? 0 : 1;
}

function describe(error: unknown): string {
  if (error instanceof TransportHttpError) {
    return `HTTP ${error.status}: ${error.body.slice(0, 500)}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

const cell = (value: string) => value.replaceAll("|", "/").replace(/\s+/g, " ");
const f1 = (n: number) => n.toFixed(1);

async function runAll(): Promise<number> {
  process.loadEnvFile(envFile);
  if (!isEnabled(process.env, "MODEL_CALLS_ENABLED")) {
    console.error("MODEL_CALLS_ENABLED must be true in the environment.");
    return 2;
  }
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      console.error(`Missing environment variable ${name}.`);
      process.exit(2);
    }
    return value;
  };
  need("CLOUDFLARE_API_TOKEN");
  // The REST route returned 400 "No route for that URI" for typesafe/jev and
  // google/gemini-3.8-flash (cause not investigated, see #39; maybe the route
  // shape of gateway models). The trial uses the AI binding as production
  // does (the same wiring as the binding path of scripts/smoke-models.ts).
  const proxy = await getPlatformProxy<{ AI: Ai }>({
    configPath: CONFIG_PATH,
    persist: false,
  });
  try {
    return await runWith(bindingTransport(proxy.env.AI, need("AI_GATEWAY_ID")));
  } finally {
    await proxy.dispose();
  }
}

async function runWith(transport: ModelTransport): Promise<number> {
  const { model } = DEFAULT_SLOTS.judge;
  const price = DEFAULT_PRICES[model];

  const header = [
    "title",
    "section",
    "category",
    "content_type",
    "noise",
    "prefilter_relevant",
    "sig",
    "nov",
    "cred",
    "reson",
    "act",
    "score_gap",
    "total",
    "selected",
    "labels",
  ];
  const rows: string[][] = [];
  let micros = 0;
  let failed = 0;
  for (const { file, fixture } of loadFixtures()) {
    try {
      const { industry, questions, input } = build(fixture);
      const raw = await transport.run(model, input);
      const { answers, usage } = parseJevOutput(questions, raw);
      const typed = answers as unknown as AnalysisAnswers;
      const scored = scoreAnalysis(typed, industry.analysis);
      if (price) {
        micros += costMicros(
          price,
          usage?.inputTokens ?? estimateTokens(input),
          usage?.outputTokens ?? 0,
        );
      }
      // Observation only: the code scores from probabilities, not `score`.
      let gap = 0;
      for (const d of DIMS) {
        let expected = 0;
        for (const [tier, p] of Object.entries(typed[d].probabilities)) {
          expected += Number(tier) * p;
        }
        gap = Math.max(gap, Math.abs(typed[d].score - expected));
      }
      const labels = industry.analysis.labels
        .map((key) => {
          const answer = typed[key];
          return answer ? `${key}=${labelValue(key, answer)}` : `${key}=?`;
        })
        .join(", ");
      rows.push([
        fixture.title,
        fixture.industry,
        scored.category,
        scored.contentType,
        scored.noiseKind,
        scored.prefilterRelevant.toFixed(2),
        ...DIMS.map((d) => f1(scored.dims[d])),
        gap.toFixed(3),
        String(scored.total),
        scored.selected ? "yes" : "no",
        labels,
      ]);
    } catch (error) {
      failed += 1;
      console.error(`${file}: ${describe(error)}`);
    }
  }

  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  console.log(line(header));
  console.log(line(header.map(() => "---")));
  for (const row of rows) console.log(line(row));
  console.log(
    `\n${rows.length} analysed, ${failed} failed, cost ${micros} micro-USD (${model})`,
  );
  return failed === 0 ? 0 : 1;
}

process.exit(dryRun ? dryRunAll() : await runAll());
