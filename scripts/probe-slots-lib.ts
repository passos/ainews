// Pure part of scripts/probe-slots.ts (#117): one text request per `write`
// and `reason` call site in src/, built with the real prompt builders from
// the real fixtures, and the maximum cost of each request. No transport, no
// ledger, no database, so tests/probe-slots.node.test.ts can import it. The
// transport is a parameter (probeSite, runPlanned); the only file it writes is
// the rejection report (saveRejection), under the system temp dir.
//
// Out of scope: the two discover sites (src/pipeline/discover/draft.ts and
// run.ts, `reason`). DISCOVERY_ENABLED is "false" in production and their
// prompts are inline in src; a follow-up issue probes them.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ZodType } from "zod";
import * as T from "../src/lib/artifacts/types.ts";
import { ARTIFACT_REGISTRY } from "../src/pipeline/artifacts/registry.ts";
import type { ArtifactEventMaterial } from "../src/pipeline/artifacts/prompts.ts";
import {
  buildWriteRequest,
  parseWriteOutput,
  writeOutputSchema,
} from "../src/pipeline/analyze/prompts.ts";
import {
  buildAskRequest,
  parseAskOutput,
  rawAskOutputSchema,
} from "../src/pipeline/ask/prompts.ts";
import type { ArticleAskContext } from "../src/pipeline/ask/prompts.ts";
import {
  buildDigestRequest,
  buildWeeklyDigestRequest,
  parseDigestOutput,
} from "../src/pipeline/digest/prompt.ts";
import type { DigestPromptInput } from "../src/pipeline/digest/prompt.ts";
import {
  buildClaimsExtractionRequest,
  parseClaimsOutput,
  rawClaimsOutputSchema,
} from "../src/pipeline/evidence/prompts.ts";
import { buildWatchSummaryPrompt } from "../src/pipeline/watch/prompts.ts";
import type { TextRequest } from "../src/providers/adapters.ts";
import {
  buildTextInput,
  parseTextOutput,
  record,
} from "../src/providers/adapters.ts";
import { costMicros } from "../src/providers/budget.ts";
import { DEFAULT_PRICES } from "../src/providers/defaults.ts";
import type { Price, SlotConfig } from "../src/providers/defaults.ts";
import type { ModelTransport } from "../src/providers/transport.ts";
import { estimateTokens } from "../src/providers/jev.ts";
import { SEED_INDUSTRIES } from "../src/server/db/seed/industries.ts";
import type { RealFixture } from "../tests/fixtures/analysis/real-shape.ts";

/** The issue's limit for one batch: $0.10 (each batch is a separate run). */
export const PROBE_CAP_MICROS = 100_000;

/**
 * Body characters taken from each fixture. Keeps the input part of the
 * estimate small; the output limit (the risk under test) does not change.
 */
export const FIXTURE_BODY_CHARS = 4000;

export interface ProbeSite {
  /** Unique name of the request in the output table. */
  id: string;
  /** Where production sends this request: file and function. */
  callSite: string;
  slot: "write" | "reason";
  request: TextRequest;
  /** True if production would accept the text (its own parser). */
  accepts: (text: string) => boolean;
  /**
   * What the rejection report says about the parser: the zod schema it
   * applies, or why there is none to apply.
   */
  diagnosis: ZodType | string;
}

/**
 * The zod schema each artifact parser applies (src/pipeline/artifacts/
 * prompts.ts). earnings_decoder is not here: production adds fields before
 * its safeParse, so the bare schema would report noise.
 */
export const ARTIFACT_SCHEMAS: Record<string, ZodType> = {
  story_brief: T.storyBriefSchema,
  audience_explain: T.audienceExplainSchema,
  research_paper_decoder: T.researchPaperDecoderSchema,
  learning_material: T.learningMaterialSchema,
  policy_impact_explorer: T.policyImpactExplorerSchema,
  classroom_discussion_builder: T.classroomDiscussionBuilderSchema,
  education_evidence_checker: T.educationEvidenceCheckerSchema,
  finance_reality_check: T.financeRealityCheckSchema,
  regulation_watch: T.regulationWatchSchema,
  finance_concept_explainer: T.financeConceptExplainerSchema,
  skills_career_trends: T.skillsCareerTrendsSchema,
  industry_impact_report: T.industryImpactReportSchema,
  supply_chain_ripple_map: T.supplyChainRippleMapSchema,
};

const NO_SCHEMA = {
  earnings_decoder: "production enriches before parse",
} as const;

// Same fence handling as the artifact parsers' extractJsonText
// (src/pipeline/artifacts/prompts.ts, private there).
function jsonText(rawText: string): string {
  const trimmed = rawText.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * The reasons a parser would reject `text`: a JSON syntax error, or the zod
 * issues of the schema. An empty list means the schema accepts the text and
 * the parser rejects it for another reason. A string says no schema applies.
 */
export function rejectionIssues(
  text: string,
  diagnosis: ZodType | string,
): unknown[] | string {
  if (typeof diagnosis === "string") return `unavailable: ${diagnosis}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText(text));
  } catch (error) {
    return [{ code: "invalid_json", message: String(error) }];
  }
  const res = diagnosis.safeParse(parsed);
  return res.success ? [] : res.error.issues;
}

/**
 * The real path of `dir` (its nearest existing ancestor, resolved through
 * symlinks, plus the rest as written); throws unless it is inside the real
 * system temp dir. Run it before anything is sent: the raw text is model
 * output and does not belong in git.
 */
export function tempDirOnly(dir: string): string {
  const wanted = resolve(dir);
  let existing = wanted;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, wanted));
  const rel = relative(realpathSync(tmpdir()), real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`rejection dir must be inside the temp dir: ${real}`);
  }
  return real;
}

/**
 * Writes the raw model text and the parser issues of one rejected request to
 * `<dir>/<site id>.<time>.json` and returns the path. The file is created
 * with `wx`, so an existing file or symlink is never followed.
 */
export function saveRejection(
  dir: string,
  site: Pick<ProbeSite, "id" | "callSite" | "diagnosis">,
  text: string,
): string {
  const target = tempDirOnly(dir);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const file = join(target, `${site.id}.${Date.now()}.json`);
  const report = {
    site: site.id,
    callSite: site.callSite,
    issues: rejectionIssues(text, site.diagnosis),
    rawText: text,
  };
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return file;
}

export interface PlannedSite extends ProbeSite {
  model: string;
  inputTokens: number;
  maxMicros: number;
}

interface NamedFixture {
  file: string;
  fixture: RealFixture;
}

function industry(slug: string) {
  const found = SEED_INDUSTRIES.find((i) => i.slug === slug);
  if (!found) throw new Error(`unknown industry ${slug}`);
  return found;
}

function body(fixture: RealFixture): string {
  return fixture.body.slice(0, FIXTURE_BODY_CHARS);
}

/** First fixture of `slug`, or the one whose file name contains `hint`. */
function pick(
  fixtures: NamedFixture[],
  slug: string,
  hint?: string,
): RealFixture {
  const found = fixtures.find(
    (f) =>
      f.fixture.industry === slug &&
      (hint === undefined || f.file.includes(hint)),
  );
  if (!found) throw new Error(`no fixture for ${slug} ${hint ?? ""}`);
  return found.fixture;
}

/** Industry of each artifact type whose eligibility needs one. */
const ARTIFACT_INDUSTRY: Record<string, { slug: string; hint?: string }> = {
  policy_impact_explorer: { slug: "education" },
  classroom_discussion_builder: { slug: "education" },
  education_evidence_checker: { slug: "education" },
  finance_reality_check: { slug: "finance", hint: "backtest" },
  regulation_watch: { slug: "finance", hint: "enforcement" },
  finance_concept_explainer: { slug: "finance", hint: "backtest" },
  earnings_decoder: { slug: "finance", hint: "enforcement" },
  skills_career_trends: { slug: "industry" },
  industry_impact_report: { slug: "industry" },
  supply_chain_ripple_map: { slug: "industry" },
};

function artifactMaterial(
  fixture: RealFixture,
  earnings: boolean,
): ArtifactEventMaterial {
  const ind = industry(fixture.industry);
  const secUrl =
    "https://www.sec.gov/Archives/edgar/data/4962/000000496226000001/axp-20260930.htm";
  return {
    eventId: 1,
    eventTitle: fixture.title,
    industryName: ind.name,
    industrySlug: ind.slug,
    disclaimer: ind.disclaimer,
    articles: [
      {
        id: 101,
        title: fixture.title,
        sourceName: fixture.source,
        sourceDomain: new URL(fixture.url).hostname,
        publishedAt: Date.parse(fixture.published_at),
        summary: fixture.summary,
        bodyText: body(fixture),
      },
    ],
    verifiedClaims: [
      {
        id: 201,
        claimText: fixture.summary,
        claimType: "fact",
        consensusStatus: "single_source",
      },
    ],
    ...(earnings
      ? {
          filing: {
            id: 301,
            accessionNumber: "0000004962-26-000001",
            form: "10-Q",
            filingDate: "2026-10-20",
            reportDate: "2026-09-30",
            secUrl,
            fiscalYear: 2026,
            fiscalPeriod: "Q3",
            companyTicker: "AXP",
            companyName: "American Express Company",
            companyCik: "0000004962",
          },
          financialFacts: [
            {
              id: 401,
              taxonomy: "us-gaap",
              concept: "Revenues",
              unit: "USD",
              val: "17500000000",
              periodStart: "2026-07-01",
              periodEnd: "2026-09-30",
              fiscalYear: 2026,
              fiscalPeriod: "Q3",
              secUrl,
            },
          ],
          calculatedMetrics: [
            {
              metricName: "Total revenues net of interest expense",
              concept: "Revenues",
              unit: "USD",
              reportedValue: "17500000000",
              reportedCitation: {
                factId: 401,
                secUrl,
                periodEnd: "2026-09-30",
              },
              priorPeriodValue: "17100000000",
              priorYearValue: "16600000000",
              guidanceComparison: "not_provided",
              deltaQoQPercent: "2.3%",
              deltaYoYPercent: "5.4%",
            },
          ],
        }
      : {}),
  };
}

function askArticle(fixture: RealFixture, id: number): ArticleAskContext {
  return {
    id,
    title: fixture.title,
    sourceName: fixture.source,
    sourceDomain: new URL(fixture.url).hostname,
    isPrimarySource: false,
    bodySha: `fixture-${id}`,
    bodyText: body(fixture),
  };
}

/** One request per call site; artifact types with audiences: one per audience. */
export function buildSites(fixtures: NamedFixture[]): ProbeSite[] {
  const tech = pick(fixtures, "technology");
  const techOther = fixtures.filter(
    (f) => f.fixture.industry === "technology",
  )[1]?.fixture;
  if (!techOther) throw new Error("need two technology fixtures");
  const techIndustry = industry("technology");
  const sites: ProbeSite[] = [];

  sites.push({
    id: "analyze.write",
    callSite: "src/pipeline/analyze/analyze.ts write()",
    slot: "write",
    request: buildWriteRequest(techIndustry.analysis, {
      title: tech.title,
      summary: tech.summary,
      body: body(tech),
      source: tech.source,
    }),
    accepts: (text) => parseWriteOutput(text) !== null,
    diagnosis: writeOutputSchema,
  });

  for (const def of Object.values(ARTIFACT_REGISTRY)) {
    const where = ARTIFACT_INDUSTRY[def.type] ?? { slug: "technology" };
    const fixture = pick(fixtures, where.slug, where.hint);
    const material = artifactMaterial(fixture, def.type === "earnings_decoder");
    for (const aud of def.audiences) {
      sites.push({
        id: `artifact.${def.type}${aud ? `.${aud}` : ""}`,
        callSite: "src/pipeline/artifacts/build.ts generateEventArtifacts()",
        slot: def.slot ?? "write",
        request: def.buildRequest(material, aud),
        accepts: (text) => def.parseOutput(text, aud, material) !== null,
        diagnosis:
          ARTIFACT_SCHEMAS[def.type] ??
          NO_SCHEMA[def.type as keyof typeof NO_SCHEMA],
      });
    }
  }

  sites.push({
    id: "evidence.claims",
    callSite: "src/pipeline/evidence/build.ts generateEventEvidence()",
    slot: "reason",
    request: buildClaimsExtractionRequest({
      eventId: 1,
      eventTitle: tech.title,
      industryName: techIndustry.name,
      disclaimer: techIndustry.disclaimer,
      articles: [
        {
          ...askArticle(tech, 101),
          isPrimarySource: true,
        },
        askArticle(techOther, 102),
      ],
    }),
    accepts: (text) => parseClaimsOutput(text) !== null,
    diagnosis: rawClaimsOutputSchema,
  });

  const question = `What does "${tech.title}" claim, and how was it evaluated?`;
  sites.push({
    id: "ask.round1",
    callSite: "src/pipeline/ask/answer.ts answerQuestion() round 1",
    slot: "reason",
    request: buildAskRequest({
      question,
      scopeDescription: "Event #1",
      articles: [askArticle(tech, 101)],
    }),
    accepts: (text) => parseAskOutput(text) !== null,
    diagnosis: rawAskOutputSchema,
  });
  sites.push({
    id: "ask.round2",
    callSite: "src/pipeline/ask/answer.ts answerQuestion() round 2",
    slot: "reason",
    request: buildAskRequest({
      question,
      scopeDescription: "Event #1",
      // Round 2 adds the supplementary page to the round-1 articles.
      articles: [askArticle(tech, 101), askArticle(techOther, -1)],
    }),
    accepts: (text) => parseAskOutput(text) !== null,
    diagnosis: rawAskOutputSchema,
  });

  const digestInput: DigestPromptInput = {
    industryName: techIndustry.name,
    disclaimer: techIndustry.disclaimer,
    periodStart: "2026-10-26",
    events: fixtures
      .filter((f) => f.fixture.industry === "technology")
      .map((f, i) => ({
        id: i + 1,
        title: f.fixture.title,
        summary: f.fixture.summary,
        sourceName: f.fixture.source,
        score: 80 - i * 5,
        articleCount: 1,
      })),
  };
  sites.push({
    id: "digest.daily",
    callSite: "src/pipeline/digest/build.ts buildDigest() daily",
    slot: "write",
    request: buildDigestRequest(digestInput),
    accepts: (text) => parseDigestOutput(text) !== null,
    diagnosis: "hand-written parser, no zod schema",
  });
  sites.push({
    id: "digest.weekly",
    callSite: "src/pipeline/digest/build.ts buildDigest() weekly",
    slot: "reason",
    request: buildWeeklyDigestRequest({
      ...digestInput,
      periodStart: "2026-10-19",
    }),
    accepts: (text) => parseDigestOutput(text) !== null,
    diagnosis: "hand-written parser, no zod schema",
  });

  sites.push({
    id: "watch.summary",
    callSite: "src/pipeline/watch/evaluate.ts evaluateEventWatches()",
    slot: "write",
    request: buildWatchSummaryPrompt(
      "What new results are there on AI agent evaluation?",
      "A new benchmark, evaluation method or measured result.",
      tech.title,
      [
        { title: tech.title, summary: tech.summary },
        { title: techOther.title, summary: techOther.summary },
      ],
    ),
    accepts: (text) => text.trim().length > 0,
    diagnosis: "plain text, only a non-empty check",
  });

  return sites;
}

/**
 * Maximum cost of one request, the same reservation the ledger makes
 * (src/providers/models.ts): estimateTokens(input) x price.in +
 * maxOutputTokens x price.out, rounded up. Gemini thinking tokens count
 * against maxOutputTokens and are billed as output, so this is an upper bound
 * up to the error of the input estimate (JSON length / 3).
 */
export function planSites(
  sites: ProbeSite[],
  slots: Record<"write" | "reason", SlotConfig>,
  prices: Record<string, Price>,
): PlannedSite[] {
  return sites.map((site) => {
    const { model } = slots[site.slot];
    const price = prices[model];
    if (!price) throw new Error(`no price for ${model} (${site.id})`);
    const inputTokens = estimateTokens(buildTextInput(model, site.request));
    return {
      ...site,
      model,
      inputTokens,
      maxMicros: costMicros(price, inputTokens, site.request.maxOutputTokens),
    };
  });
}

export function totalMaxMicros(plan: PlannedSite[]): number {
  return plan.reduce((sum, site) => sum + site.maxMicros, 0);
}

/** The reason to refuse a real run, or null when it may start. */
export function refusal(
  totalMax: number,
  cap: number = PROBE_CAP_MICROS,
): string | null {
  return totalMax > cap
    ? `estimated max ${totalMax} micro-USD exceeds the cap ${cap} micro-USD`
    : null;
}

export type BatchName = "B1" | "B2" | "B3";
export const BATCH_NAMES: readonly BatchName[] = ["B1", "B2", "B3"];

/** B1: every probed site that is not an artifact, in this order. */
export const B1_IDS = [
  "analyze.write",
  "watch.summary",
  "evidence.claims",
  "ask.round1",
  "ask.round2",
  "digest.daily",
  "digest.weekly",
] as const;

export interface Batch {
  name: BatchName;
  sites: PlannedSite[];
  totalMax: number;
}

function batch(name: BatchName, sites: PlannedSite[]): Batch {
  return { name, sites, totalMax: totalMaxMicros(sites) };
}

/**
 * B1 = B1_IDS. B2 and B3 = the artifact requests in registry order, cut at
 * the point where the larger half has the smallest estimated max. Throws if a
 * site is in no batch.
 */
export function splitBatches(plan: PlannedSite[]): Batch[] {
  const b1 = B1_IDS.map((id) => {
    const site = plan.find((s) => s.id === id);
    if (!site) throw new Error(`no site ${id}`);
    return site;
  });
  const rest = plan.filter((s) => !b1.includes(s));
  const stray = rest.find((s) => !s.id.startsWith("artifact."));
  if (stray) throw new Error(`site ${stray.id} is in no batch`);
  const total = totalMaxMicros(rest);
  let cut = 0;
  let best = Infinity;
  let prefix = 0;
  for (let i = 1; i < rest.length; i++) {
    prefix += rest[i - 1].maxMicros;
    const larger = Math.max(prefix, total - prefix);
    if (larger < best) {
      best = larger;
      cut = i;
    }
  }
  return [
    batch("B1", b1),
    batch("B2", rest.slice(0, cut)),
    batch("B3", rest.slice(cut)),
  ];
}

export type Decision =
  /** Bad arguments: exit 2. */
  | { kind: "usage"; message: string }
  /** Over the cap: exit 2, before any env file is read. */
  | { kind: "refuse"; message: string }
  | { kind: "dry"; batches: Batch[] }
  | { kind: "run"; batch: Batch };

/**
 * What the command line asks for. Real mode needs --yes-spend and --batch,
 * and is refused when that batch can cost more than the cap.
 */
export function decide(
  args: string[],
  batches: Batch[],
  cap: number = PROBE_CAP_MICROS,
): Decision {
  const dryRun = args.includes("--dry-run");
  const yesSpend = args.includes("--yes-spend");
  if (dryRun === yesSpend) {
    return {
      kind: "usage",
      message: "Pass exactly one of --dry-run or --yes-spend.",
    };
  }
  const at = args.indexOf("--batch");
  let selected: Batch | undefined;
  if (at >= 0) {
    selected = batches.find((b) => b.name === args[at + 1]);
    if (!selected) {
      return {
        kind: "usage",
        message: `--batch needs one of ${BATCH_NAMES.join(", ")}.`,
      };
    }
  }
  const only = args.indexOf("--only");
  if (only >= 0) {
    // A re-run of a few requests of one batch, e.g. after a rejection.
    const ids = (args[only + 1] ?? "").split(",").filter(Boolean);
    const unknown = selected
      ? ids.filter((id) => !selected!.sites.some((s) => s.id === id))
      : ids;
    if (!selected || ids.length === 0 || unknown.length > 0) {
      return {
        kind: "usage",
        message:
          "--only needs --batch and a comma list of site ids of that batch" +
          (unknown.length > 0 ? ` (unknown: ${unknown.join(", ")}).` : "."),
      };
    }
    selected = batch(
      selected.name,
      selected.sites.filter((s) => ids.includes(s.id)),
    );
  }
  if (dryRun) return { kind: "dry", batches: selected ? [selected] : batches };
  if (!selected) {
    return { kind: "usage", message: "--yes-spend needs --batch B1|B2|B3." };
  }
  const reason = refusal(selected.totalMax, cap);
  if (reason) return { kind: "refuse", message: `${selected.name}: ${reason}` };
  return { kind: "run", batch: selected };
}

export interface ProbeResult {
  finishReason: string;
  outputTokens: number;
  thinkingTokens: number;
  cost: number;
  accepted: boolean;
}

/**
 * Sends the sites one by one. Stops at the first finishReason that is not
 * STOP, at the first error, and before a site that could take the spend over
 * `cap`. The cap compares the estimated max of the next site with the spend so
 * far, so it guards the estimate (input tokens are chars / 3), not the bill.
 * Returns the exit code: 0 only if every site is STOP and parsed.
 */
export async function runBatch(
  sites: PlannedSite[],
  probe: (site: PlannedSite) => Promise<ProbeResult>,
  log: (line: string) => void,
  cap: number,
): Promise<number> {
  log(
    "site | model | finishReason | output tokens | thinking tokens | cost micro-USD | parser",
  );
  let spent = 0;
  let rejected = 0;
  for (const site of sites) {
    if (spent + site.maxMicros > cap) {
      log(`STOP before ${site.id}: the cap could be exceeded`);
      return 1;
    }
    let r: ProbeResult;
    try {
      r = await probe(site);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`STOP at ${site.id}: ${message}`);
      return 1;
    }
    spent += r.cost;
    log(
      [
        site.id,
        site.model,
        r.finishReason,
        r.outputTokens,
        r.thinkingTokens,
        r.cost,
        r.accepted ? "ok" : "REJECTED",
      ].join(" | "),
    );
    if (r.finishReason !== "STOP") {
      log(
        `STOP at ${site.id}: finishReason ${r.finishReason}, cost so far ${spent} micro-USD`,
      );
      return 1;
    }
    if (!r.accepted) rejected += 1;
  }
  log(
    `${sites.length} calls, ${rejected} rejected by the parser, cost ${spent} micro-USD`,
  );
  return rejected === 0 ? 0 : 1;
}

/** The finishReason of the first candidate, read without parsing the text. */
function rawFinishReason(raw: unknown): string {
  const body = record(raw, "response");
  const inner =
    "state" in body && "result" in body ? record(body.result, "result") : body;
  const candidates = inner.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const reason = (first as { finishReason?: unknown } | undefined)
    ?.finishReason;
  return typeof reason === "string" ? reason : "?";
}

/**
 * One real request. The finishReason and the token counts are read before the
 * text is parsed: a thinking-only reply (MAX_TOKENS, no content) makes the
 * adapter throw, and the row must still show what it cost. A rejected reply
 * goes to saveRejection.
 */
export async function probeSite(
  site: PlannedSite,
  transport: ModelTransport,
  rejectDir: string,
  log: (line: string) => void,
): Promise<ProbeResult> {
  const raw = await transport.run(
    site.model,
    buildTextInput(site.model, site.request),
  );
  const body = record(raw, "response");
  const meta = record(
    ("state" in body && "result" in body ? record(body.result, "result") : body)
      .usageMetadata,
    "usageMetadata",
  );
  const count = (field: string): number => Number(meta[field] ?? 0);
  const outputTokens = count("candidatesTokenCount");
  const thinkingTokens = count("thoughtsTokenCount");
  let text = "";
  try {
    text = parseTextOutput(site.model, raw).text;
  } catch {
    // No content: accepted stays false and the finishReason says why.
  }
  const accepted = text !== "" && site.accepts(text);
  if (!accepted) {
    log(`rejected ${site.id}: ${saveRejection(rejectDir, site, text)}`);
  }
  return {
    finishReason: rawFinishReason(raw),
    outputTokens,
    thinkingTokens,
    cost: costMicros(
      DEFAULT_PRICES[site.model],
      count("promptTokenCount"),
      outputTokens + thinkingTokens,
    ),
    accepted,
  };
}

/**
 * Runs one decided batch; the cap is the batch's own estimated max, not the
 * default one.
 */
export async function runPlanned(
  batch: Batch,
  transport: ModelTransport,
  rejectDir: string,
  log: (line: string) => void,
): Promise<number> {
  // First, before anything is sent.
  const dir = tempDirOnly(rejectDir);
  return runBatch(
    batch.sites,
    (site) => probeSite(site, transport, dir, log),
    log,
    batch.totalMax,
  );
}
