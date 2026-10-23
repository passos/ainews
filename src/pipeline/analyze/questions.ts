// The one Jev request per article: state + every question (prefilter,
// category, content type, noise, five dimensions, the industry's labels).
// Jev bills input tokens only, so one call with all questions is cheapest.
// models.judge() cuts `state.body` to fit the context (jev.ts).
//
// Bump ANALYZE_CODE_VERSION on every change to the questions built here:
// it is part of the prompt version, so analysed articles keep their rows and
// only new ones use the new questions.
import type { JevQuestion, JevState } from "../../providers/jev";
import { DIMS } from "./config";
import type { AnalysisConfig, Dim } from "./config";
import { LABELS } from "./labels";
import { UNTRUSTED, WRITE_BASE_PROMPT } from "./prompts";

export const ANALYZE_CODE_VERSION = 1;

/** Fixed definitions (adapted from AIHOT industry/prompts/selection-score.md). */
const DIM_INSTRUCTIONS: Record<Dim, string> = {
  sig: "Significance: how much weight this event has on the timeline of this section.",
  nov: "Novelty: how much new understanding the material brings, not how new the headline is.",
  cred: "Credibility: how strongly the material itself supports its core facts, not how well known the source is.",
  reson:
    "Resonance: how much readers of this section will feel it concerns them.",
  act: "Actionability: how much readers can use it right away to learn, decide or change what they do.",
};

export interface AnalysisArticle {
  title: string;
  summary: string | null;
  /** Epoch milliseconds. */
  publishedAt: number | null;
}

export interface AnalysisSource {
  name: string;
}

export interface AnalysisIndustry {
  name: string;
  analysis: AnalysisConfig;
}

export type AnalysisQuestions = Record<string, JevQuestion>;

const ask = (text: string) => `${UNTRUSTED} ${text}`;

export function buildAnalysisRequest(
  article: AnalysisArticle,
  source: AnalysisSource,
  industry: AnalysisIndustry,
  bodyMd: string,
): { state: JevState; questions: AnalysisQuestions } {
  const config = industry.analysis;
  // Every value is JSON (no undefined): the official input schema allows
  // only strings, numbers, booleans, null, arrays and objects.
  const state: JevState = {
    title: article.title,
    summary: article.summary ?? "",
    body: bodyMd,
    section: industry.name,
    source: source.name,
    published_at:
      article.publishedAt === null
        ? null
        : new Date(article.publishedAt).toISOString(),
  };

  const questions: AnalysisQuestions = {
    prefilter: {
      type: "choice",
      instructions: ask(
        "Is this material relevant to this section, off topic, or noise?",
      ),
      criteria: { ...config.prefilter },
    },
    category: {
      type: "choice",
      instructions: ask("Which category of this section fits it best?"),
      criteria: { ...config.categories },
    },
    content_type: {
      type: "choice",
      instructions: ask("What type of content is this?"),
      criteria: descriptions(config.contentTypes),
    },
    noise: {
      type: "choice",
      instructions: ask("What kind of noise is this, if any?"),
      criteria: descriptions(config.noise),
    },
  };
  for (const d of DIMS) {
    questions[d] = {
      type: "score",
      instructions: ask(DIM_INSTRUCTIONS[d]),
      criteria: [...config.dimensions[d]],
    };
  }
  for (const key of config.labels) {
    questions[key] = {
      type: "choice",
      instructions: ask(LABELS[key].instructions),
      criteria: { ...LABELS[key].options },
    };
  }
  return { state, questions };
}

function descriptions(
  entries: Record<string, { description: string }>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, v]) => [key, v.description]),
  );
}

/**
 * 16 hex characters of sha256 over the code version, the industry's
 * analysis config and the write prompt. A change to any of them gives new
 * articles a new version; analysed articles are not redone.
 */
export async function promptVersion(config: AnalysisConfig): Promise<string> {
  const text = stableJson({
    code: ANALYZE_CODE_VERSION,
    analysis: config,
    write: WRITE_BASE_PROMPT,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** JSON with object keys sorted, so key order does not change the hash. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
