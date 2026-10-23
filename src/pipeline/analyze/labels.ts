// Evidence labels (Newsren §6, §4). The options are fixed here; an industry
// only picks which labels it asks (AnalysisConfig.labels). Each option's
// description is the Jev `choice` criterion.

export const LABELS = {
  publication_status: {
    instructions: "Is the research described here a preprint or peer reviewed?",
    options: {
      preprint:
        "A preprint or working paper that has not passed peer review (for example arXiv, SSRN).",
      peer_reviewed:
        "Published in a peer-reviewed journal or accepted at a peer-reviewed conference.",
      not_applicable: "The material does not report a research study.",
    },
  },
  performance_basis: {
    instructions: "What are the performance claims in this material based on?",
    options: {
      backtest: "A backtest on historical data.",
      simulated: "A simulation, a paper trading run or a synthetic benchmark.",
      live: "Live use with real users, money or operations.",
      not_applicable: "The material makes no performance claims.",
    },
  },
  development_stage: {
    instructions: "At what stage is the development described here?",
    options: {
      announcement: "An announcement or plan; nothing is in use yet.",
      pilot: "A pilot, trial or limited test.",
      deployment: "A production deployment or general availability.",
      regulatory_finding:
        "A decision, finding or rule from a regulator or a court.",
      not_applicable: "The material does not describe a development.",
    },
  },
  claim_mode: {
    instructions:
      "Does the material state facts, make forecasts, or both in equal weight?",
    options: {
      fact: "Mainly reports what has happened or what was measured.",
      forecast: "Mainly predicts or projects what will happen.",
      mixed: "Both facts and forecasts, in about equal weight.",
    },
  },
  study_population: {
    instructions: "Who are the participants of the study described here?",
    options: {
      k12_students: "Primary or secondary school students.",
      higher_ed_students: "College or university students.",
      educators: "Teachers, lecturers or other educators.",
      adult_learners: "Adults learning outside formal schooling.",
      not_stated: "A study is described, but its participants are not stated.",
      not_applicable: "The material does not describe a study with people.",
    },
  },
  outcome_measure: {
    instructions: "What outcome does the study described here measure?",
    options: {
      test_scores: "Scores on tests or exams.",
      transfer: "Use of the learning in new tasks or settings.",
      completion_speed: "How fast tasks or courses are completed.",
      engagement: "Engagement, usage or retention.",
      self_report: "What participants say about themselves (surveys).",
      not_stated:
        "A study is described, but its outcome measure is not stated.",
      not_applicable: "The material does not describe a measured outcome.",
    },
  },
} as const satisfies Record<
  string,
  { instructions: string; options: Record<string, string> }
>;

export type LabelKey = keyof typeof LABELS;

export const LABEL_KEYS = Object.keys(LABELS) as LabelKey[];

/** Stored instead of the choice when Jev is not sure enough. */
export const UNCERTAIN = "uncertain";

/** Below this confidence a label is stored as UNCERTAIN. */
export const MIN_LABEL_CONFIDENCE = 0.5;

/** The stored value of one label answer. */
export function labelValue(
  key: LabelKey,
  answer: { choice: string; confidence: number },
): string {
  const known = Object.hasOwn(LABELS[key].options, answer.choice);
  return known && answer.confidence >= MIN_LABEL_CONFIDENCE
    ? answer.choice
    : UNCERTAIN;
}
