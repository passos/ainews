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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";
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
import type { ModelTransport } from "../src/providers/transport.ts";
import type { RealFixture } from "../tests/fixtures/analysis/real-shape.ts";
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

const SCHEMA = fileURLToPath(
  new URL("../tests/fixtures/jev/schema-input.json", import.meta.url),
);

/** The request as sent: questions of the seeded industry + the fixture. */
function build(fixture: RealFixture) {
  const industry = industryOf(fixture);
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

const cell = (value: string) => value.replaceAll("|", "/").replace(/\s+/g, " ");
const f1 = (n: number) => n.toFixed(1);

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

process.exit(
  dryRun ? dryRunAll() : await withBindingTransport(envFile, runWith),
);
