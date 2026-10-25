import { createHash } from "node:crypto";
import { createModelClient, type ModelClient } from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import type { PipelineEnv } from "../messages";
import {
  analysisConfigSchema,
  type AnalysisConfig,
  DIMS,
  type Dim,
} from "../analyze/config";
import { LABEL_KEYS, type LabelKey } from "../analyze/labels";
import { WRITE_THINKING } from "../analyze/prompts";

export interface DraftIndustryInput {
  description: string;
  name?: string;
}

export interface DraftIndustryResult {
  name: string;
  slug: string;
  publishMode: "review";
  disclaimer: string | null;
  primaryDomains: string[];
  analysis: AnalysisConfig;
}

export interface DraftDeps {
  db: D1Database;
  env: PipelineEnv;
  transport?: ModelTransport;
  models?: ModelClient;
  now?: () => number;
}

function sha256(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeWeights(
  rawWeights?: Record<string, unknown>,
): Record<Dim, number> {
  const result: Record<Dim, number> = {
    sig: 2,
    nov: 2,
    cred: 2,
    reson: 2,
    act: 2,
  };
  if (!rawWeights || typeof rawWeights !== "object") return result;

  let sum = 0;
  for (const dim of DIMS) {
    const val = Number(rawWeights[dim]);
    result[dim] = Number.isInteger(val) && val >= 0 ? val : 2;
    sum += result[dim];
  }

  // Adjust to exactly 10
  if (sum !== 10) {
    let diff = 10 - sum;
    for (const dim of DIMS) {
      if (diff === 0) break;
      if (diff > 0) {
        result[dim] += 1;
        diff -= 1;
      } else if (diff < 0 && result[dim] > 0) {
        result[dim] -= 1;
        diff += 1;
      }
    }
  }
  return result;
}

function repairAnalysisConfig(raw: Record<string, unknown>): AnalysisConfig {
  const prefilterRaw = (raw.prefilter as Record<string, unknown>) ?? {};
  const prefilter = {
    relevant:
      typeof prefilterRaw.relevant === "string" && prefilterRaw.relevant.trim()
        ? prefilterRaw.relevant.trim()
        : "Industry-relevant development, research, product, or news.",
    off_topic:
      typeof prefilterRaw.off_topic === "string" &&
      prefilterRaw.off_topic.trim()
        ? prefilterRaw.off_topic.trim()
        : "Material outside this industry or only mentioning it in passing.",
    noise:
      typeof prefilterRaw.noise === "string" && prefilterRaw.noise.trim()
        ? prefilterRaw.noise.trim()
        : "Marketing, promotions, spam, job ads, and low-substance listicles.",
  };

  const categoriesRaw = (raw.categories as Record<string, unknown>) ?? {};
  const categories: Record<string, string> = {};
  for (const [k, v] of Object.entries(categoriesRaw)) {
    if (typeof v === "string" && v.trim()) {
      categories[slugify(k)] = v.trim();
    }
  }
  if (Object.keys(categories).length < 2) {
    categories.core_developments =
      "Core industry news, breakthroughs, and primary announcements.";
    categories.market_and_applications =
      "Commercial use, market analysis, and practical deployment.";
  }

  const contentTypesRaw = (raw.contentTypes as Record<string, unknown>) ?? {};
  const contentTypes: Record<
    string,
    { description: string; weights: Record<Dim, number> }
  > = {};
  for (const [k, v] of Object.entries(contentTypesRaw)) {
    if (v && typeof v === "object") {
      const item = v as Record<string, unknown>;
      const desc =
        typeof item.description === "string" && item.description.trim()
          ? item.description.trim()
          : "General industry report or announcement.";
      contentTypes[slugify(k)] = {
        description: desc,
        weights: sanitizeWeights(item.weights as Record<string, unknown>),
      };
    }
  }
  if (Object.keys(contentTypes).length < 1) {
    contentTypes.standard_report = {
      description: "Standard industry news report or update.",
      weights: { sig: 2, nov: 2, cred: 2, reson: 2, act: 2 },
    };
  }

  const defaultTiers = [
    "Negligible or routine occurrence",
    "Minor incremental note",
    "Moderate industry interest",
    "High significance development",
    "Landmark breakthrough or defining event",
  ] as const;

  const toTiers = (val: unknown): [string, string, string, string, string] => {
    if (
      Array.isArray(val) &&
      val.length === 5 &&
      val.every((x) => typeof x === "string" && x.trim().length > 0)
    ) {
      return [val[0], val[1], val[2], val[3], val[4]];
    }
    return [
      defaultTiers[0],
      defaultTiers[1],
      defaultTiers[2],
      defaultTiers[3],
      defaultTiers[4],
    ];
  };

  const rawDims = (raw.dimensions as Record<string, unknown>) ?? {};
  const dimensions = {
    sig: toTiers(rawDims.sig),
    nov: toTiers(rawDims.nov),
    cred: toTiers(rawDims.cred),
    reson: toTiers(rawDims.reson),
    act: toTiers(rawDims.act),
  };

  const noiseRaw = (raw.noise as Record<string, unknown>) ?? {};
  const noise: Record<
    string,
    { description: string; caps: Partial<Record<Dim, number>> }
  > = {
    none: {
      description: "No noise filter applied",
      caps: {},
    },
  };
  for (const [k, v] of Object.entries(noiseRaw)) {
    if (k !== "none" && v && typeof v === "object") {
      const item = v as Record<string, unknown>;
      const desc =
        typeof item.description === "string" && item.description.trim()
          ? item.description.trim()
          : "Noise filter";
      noise[slugify(k)] = {
        description: desc,
        caps: (item.caps as Partial<Record<Dim, number>>) ?? {},
      };
    }
  }

  const rawLabels = Array.isArray(raw.labels) ? raw.labels : [];
  const validLabels = new Set<LabelKey>(LABEL_KEYS);
  const labels: LabelKey[] = [];
  for (const l of rawLabels) {
    if (
      typeof l === "string" &&
      validLabels.has(l as LabelKey) &&
      !labels.includes(l as LabelKey)
    ) {
      labels.push(l as LabelKey);
    }
  }
  if (labels.length === 0) {
    labels.push("claim_mode", "development_stage");
  }

  const rawThresh = (raw.thresholds as Record<string, unknown>) ?? {};
  const thresholds = {
    prefilterMinRelevant:
      typeof rawThresh.prefilterMinRelevant === "number" &&
      rawThresh.prefilterMinRelevant >= 0 &&
      rawThresh.prefilterMinRelevant <= 1
        ? rawThresh.prefilterMinRelevant
        : 0.3,
    select:
      typeof rawThresh.select === "number" &&
      rawThresh.select >= 0 &&
      rawThresh.select <= 100
        ? rawThresh.select
        : 50,
  };

  const summaryGuidance =
    typeof raw.summaryGuidance === "string" && raw.summaryGuidance.trim()
      ? raw.summaryGuidance.trim()
      : "Summarize the core facts, what happened, who is involved, and why it matters.";

  const rawGuardrails = Array.isArray(raw.guardrails) ? raw.guardrails : [];
  const guardrails: string[] = [];
  for (const g of rawGuardrails) {
    if (typeof g === "string" && g.trim()) {
      guardrails.push(g.trim());
    }
  }
  if (guardrails.length === 0) {
    guardrails.push(
      "Distinguish verified facts from speculation or claims.",
      "Identify the primary sources or organizations involved.",
    );
  }

  const candidate: AnalysisConfig = {
    prefilter,
    categories,
    contentTypes,
    dimensions,
    noise,
    labels,
    thresholds,
    summaryGuidance,
    guardrails,
  };

  return analysisConfigSchema.parse(candidate);
}

export async function draftIndustryConfig(
  deps: DraftDeps,
  input: DraftIndustryInput,
): Promise<DraftIndustryResult> {
  const transport =
    deps.transport ??
    (deps.env.AI
      ? bindingTransport(deps.env.AI, deps.env.AI_GATEWAY_ID ?? "")
      : {
          run: () => Promise.reject(new Error("no AI binding")),
        });

  const models =
    deps.models ??
    createModelClient({
      db: deps.db,
      transport,
      env: deps.env,
      now: deps.now ?? (() => Date.now()),
    });

  const prompt = [
    "You are an expert editorial curator creating a comprehensive AI News section configuration for an automated newsroom.",
    `Section Description: ${input.description}`,
    input.name ? `Suggested Section Name: ${input.name}` : "",
    "",
    "Draft a complete section configuration in strictly valid JSON format.",
    "The JSON must have the following keys:",
    "- 'name': string (the editorial title of the section, e.g. 'Biotechnology & Therapeutics')",
    "- 'slug': string (URL-safe identifier with lowercase alphanumeric and hyphens, e.g. 'biotech')",
    "- 'disclaimer': string or null (editorial/financial/medical disclaimer if needed)",
    "- 'primaryDomains': array of top domain strings for this industry (e.g. ['nature.com', 'biorxiv.org'])",
    "- 'analysis': object matching the AnalysisConfig schema:",
    "    * 'prefilter': { 'relevant': string, 'off_topic': string, 'noise': string }",
    "    * 'categories': record of at least 2 categories (key -> description)",
    "    * 'contentTypes': record of at least 1 content type, each with 'description' and 'weights'.",
    "        CRITICAL: Each 'weights' object MUST have integers for { sig, nov, cred, reson, act } that sum to EXACTLY 10.",
    "    * 'dimensions': { 'sig': 5 strings, 'nov': 5 strings, 'cred': 5 strings, 'reson': 5 strings, 'act': 5 strings }",
    "    * 'noise': record containing at least 'none': { 'description': 'No noise filter applied', 'caps': {} }",
    `    * 'labels': array of subset of valid keys: ${JSON.stringify(LABEL_KEYS)}`,
    "    * 'thresholds': { 'prefilterMinRelevant': 0.3, 'select': 50 }",
    "    * 'summaryGuidance': string instructions for writing news summaries",
    "    * 'guardrails': array of strings for quality and accuracy rules",
    "",
    "Output ONLY the JSON object. Do not enclose in markdown fences or include explanations.",
  ].join("\n");

  const key = `draft_industry:${sha256(input.description + (input.name ?? ""))}`;
  const request = {
    system:
      "You generate structured JSON configurations for automated editorial news analysis.",
    prompt,
    maxOutputTokens: 3000,
    thinkingConfig: WRITE_THINKING,
  };

  const response = await models.generateText("reason", key, request);
  let rawText = response.text.trim();
  if (rawText.startsWith("```")) {
    rawText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  let parsedJson: Record<string, unknown> = {};
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    // If raw JSON parse fails, attempt regex match for object
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsedJson = JSON.parse(match[0]);
      } catch {
        parsedJson = {};
      }
    }
  }

  const name =
    typeof parsedJson.name === "string" && parsedJson.name.trim()
      ? parsedJson.name.trim()
      : input.name?.trim() || "New Section";

  const slug =
    typeof parsedJson.slug === "string" && parsedJson.slug.trim()
      ? slugify(parsedJson.slug)
      : slugify(name);

  const disclaimer =
    typeof parsedJson.disclaimer === "string" && parsedJson.disclaimer.trim()
      ? parsedJson.disclaimer.trim()
      : null;

  const rawDomains = Array.isArray(parsedJson.primaryDomains)
    ? parsedJson.primaryDomains
    : [];
  const primaryDomains = rawDomains
    .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    .map((d) => d.trim().toLowerCase());

  const rawAnalysis =
    parsedJson.analysis && typeof parsedJson.analysis === "object"
      ? (parsedJson.analysis as Record<string, unknown>)
      : parsedJson;

  const analysis = repairAnalysisConfig(rawAnalysis);

  return {
    name,
    slug,
    publishMode: "review",
    disclaimer,
    primaryDomains,
    analysis,
  };
}
