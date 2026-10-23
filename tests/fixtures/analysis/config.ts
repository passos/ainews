// Neutral fake AnalysisConfig and Jev answers for tests. No real industry
// criteria: those are #8's.
import { DIMS } from "../../../src/pipeline/analyze/config";
import type { AnalysisConfig, Dim } from "../../../src/pipeline/analyze/config";
import { LABELS } from "../../../src/pipeline/analyze/labels";
import type {
  AnalysisAnswers,
  ChoiceAnswer,
  ScoreAnswer,
} from "../../../src/pipeline/analyze/score";

export const choice = (key: string, confidence = 0.9): ChoiceAnswer => ({
  choice: key,
  confidence,
  probabilities: { [key]: confidence },
});

/**
 * `score` is deliberately 0: the code must use `probabilities` (tier index
 * -> p), not the score field.
 */
export const tier = (probabilities: Record<string, number>): ScoreAnswer => ({
  score: 0,
  confidence: 0.9,
  probabilities,
});

export interface AnswerPatch {
  relevant?: number;
  category?: string;
  contentType?: string;
  noise?: string;
  dims?: Partial<Record<Dim, Record<string, number>>>;
  labels?: Record<string, ChoiceAnswer>;
}

/** Relevant, top tier on every dimension, first option of every label. */
export function fakeAnswers(
  config: AnalysisConfig,
  patch: AnswerPatch = {},
): AnalysisAnswers {
  const relevant = patch.relevant ?? 0.9;
  const answers: AnalysisAnswers = {
    prefilter: {
      choice: relevant >= 0.5 ? "relevant" : "off_topic",
      confidence: 0.9,
      probabilities: { relevant, off_topic: 1 - relevant, noise: 0 },
    },
    category: choice(patch.category ?? "alpha"),
    content_type: choice(patch.contentType ?? "report"),
    noise: choice(patch.noise ?? "none"),
  } as unknown as AnalysisAnswers; // dimensions and labels follow
  for (const d of DIMS) answers[d] = tier(patch.dims?.[d] ?? { "4": 1 });
  for (const key of config.labels) {
    answers[key] =
      patch.labels?.[key] ?? choice(Object.keys(LABELS[key].options)[0]);
  }
  return answers;
}

/** The binding's Jev response around `answers`. */
export function jevResponse(answers: AnalysisAnswers) {
  return {
    state: "Completed",
    result: {
      model: "jev-test",
      answers,
      usage: { input_tokens: 1000, output_tokens: 0 },
    },
  };
}

const tiers = (d: string) =>
  [`${d} 0`, `${d} 1`, `${d} 2`, `${d} 3`, `${d} 4`] as [
    string,
    string,
    string,
    string,
    string,
  ];

export function fakeAnalysisConfig(
  patch: Partial<AnalysisConfig> = {},
): AnalysisConfig {
  return {
    prefilter: {
      relevant: "About the test topic.",
      off_topic: "About something else.",
      noise: "Promotion or filler.",
    },
    categories: { alpha: "Category alpha.", beta: "Category beta." },
    contentTypes: {
      report: {
        description: "A report.",
        weights: { sig: 2, nov: 2, cred: 2, reson: 2, act: 2 },
      },
      study: {
        description: "A study.",
        weights: { sig: 1, nov: 3, cred: 4, reson: 1, act: 1 },
      },
    },
    dimensions: {
      sig: tiers("sig"),
      nov: tiers("nov"),
      cred: tiers("cred"),
      reson: tiers("reson"),
      act: tiers("act"),
    },
    noise: {
      none: { description: "No noise.", caps: {} },
      hype: { description: "Hype.", caps: { sig: 4 } },
    },
    labels: ["publication_status", "claim_mode"],
    thresholds: { prefilterMinRelevant: 0.3, select: 60 },
    summaryGuidance: "Say what happened.",
    guardrails: ["Do not give advice."],
    ...patch,
  };
}
