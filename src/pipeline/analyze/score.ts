// Deterministic scoring on top of the Jev answers (architecture §4):
//
//   prefilter: probabilities.relevant >= prefilterMinRelevant (not the choice)
//   dim d:     expected tier = sum(i * p[i]), i = 0..4; x 2.5 -> 0-10
//              capped at noise[noise.choice].caps[d] (default 10)
//   total:     round(sum(weights[content_type][d] * capped d)), 0-100
//   selected:  prefilter passed and total >= select
//
// The `score` field of a Jev answer is not used: the expected tier is
// computed from the distribution, so its formula does not matter.
import { DIMS } from "./config";
import type { AnalysisConfig, Dim } from "./config";
import type { LabelKey } from "./labels";

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Answers by question name (questions.ts). */
export type AnalysisAnswers = {
  prefilter: ChoiceAnswer;
  category: ChoiceAnswer;
  content_type: ChoiceAnswer;
  noise: ChoiceAnswer;
} & Record<Dim, ScoreAnswer> &
  Partial<Record<LabelKey, ChoiceAnswer>>;

export interface Scored {
  prefilterRelevant: number;
  prefilterPass: boolean;
  category: string;
  contentType: string;
  noiseKind: string;
  /** 0-10 per dimension, after the noise caps. */
  dims: Record<Dim, number>;
  /** 0-100, an integer. */
  total: number;
  selected: boolean;
}

/** Number of tiers per dimension (AnalysisConfig.dimensions). */
const TIERS = 5;
/** Tier index 0-4 -> 0-10. */
const TO_TEN = 10 / (TIERS - 1);

export function scoreAnalysis(
  answers: AnalysisAnswers,
  config: AnalysisConfig,
): Scored {
  const prefilterRelevant = answers.prefilter.probabilities.relevant ?? 0;
  const prefilterPass =
    prefilterRelevant >= config.thresholds.prefilterMinRelevant;

  const contentType = answers.content_type.choice;
  const type = Object.hasOwn(config.contentTypes, contentType)
    ? config.contentTypes[contentType]
    : undefined;
  if (!type) throw new RangeError(`unknown content type ${contentType}`);
  const noiseKind = answers.noise.choice;
  const caps = Object.hasOwn(config.noise, noiseKind)
    ? config.noise[noiseKind].caps
    : {};

  const dims = {} as Record<Dim, number>;
  let weighted = 0;
  for (const d of DIMS) {
    const capped = Math.min(expectedTier(answers[d]) * TO_TEN, caps[d] ?? 10);
    dims[d] = capped;
    weighted += type.weights[d] * capped;
  }
  const total = Math.round(weighted);

  return {
    prefilterRelevant,
    prefilterPass,
    category: answers.category.choice,
    contentType,
    noiseKind,
    dims,
    total,
    selected: prefilterPass && total >= config.thresholds.select,
  };
}

/** sum(i * p[i]) over the tier indexes; missing tiers count as 0. */
function expectedTier(answer: ScoreAnswer): number {
  let sum = 0;
  for (let i = 0; i < TIERS; i++) {
    sum += i * (answer.probabilities[String(i)] ?? 0);
  }
  return sum;
}
