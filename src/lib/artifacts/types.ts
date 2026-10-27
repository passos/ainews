import { z } from "zod";

export const ARTIFACT_TYPES = [
  "story_brief",
  "audience_explain",
  "research_paper_decoder",
  "revision_diff",
  "learning_material",
  "policy_impact_explorer",
  "classroom_discussion_builder",
  "education_evidence_checker",
  "finance_reality_check",
  "regulation_watch",
  "finance_concept_explainer",
  "skills_career_trends",
  "industry_impact_report",
  "supply_chain_ripple_map",
  "earnings_decoder",
  "launch_reality_check",
  "technology_evolution_timeline",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_AUDIENCES = [
  "student",
  "educator",
  "professional",
] as const;
export type ArtifactAudience = (typeof ARTIFACT_AUDIENCES)[number];

export const ARTIFACT_STATUSES = [
  "published",
  "pending_review",
  "rejected",
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

// -----------------------------------------------------------------------------
// Story Brief Schema & Type (N§3: What happened, What is new, What evidence exists, What to watch next)
// -----------------------------------------------------------------------------

export const storyBriefSchema = z.strictObject({
  whatHappened: z.string().min(1),
  whatIsNew: z.string().min(1),
  whatEvidenceExists: z.string().min(1),
  whatToWatchNext: z.string().min(1),
});

export type StoryBrief = z.infer<typeof storyBriefSchema>;

// -----------------------------------------------------------------------------
// Audience Explain Schema & Type (N§2.3: Student, Educator, Professional)
// -----------------------------------------------------------------------------

export const glossaryItemSchema = z.strictObject({
  term: z.string().min(1),
  definition: z.string().min(1),
});
export type GlossaryItem = z.infer<typeof glossaryItemSchema>;

export const audienceExplainSchema = z.strictObject({
  audience: z.enum(ARTIFACT_AUDIENCES),
  overview: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).min(1),
  implications: z.array(z.string().min(1)).min(1),
  glossary: z.array(glossaryItemSchema),
});

export type AudienceExplain = z.infer<typeof audienceExplainSchema>;

// -----------------------------------------------------------------------------
// Research Paper Decoder Schema & Type (N§3: arXiv paper hypothesis, method, findings, limitations, applications)
// -----------------------------------------------------------------------------

export const researchPaperDecoderSchema = z.strictObject({
  hypothesis: z.string().min(1),
  method: z.string().min(1),
  findings: z.string().min(1),
  limitations: z.string().min(1),
  applications: z.string().min(1),
});

export type ResearchPaperDecoder = z.infer<typeof researchPaperDecoderSchema>;

// -----------------------------------------------------------------------------
// Revision Diff Schema & Type (N§2.2: What is new across event revisions)
// -----------------------------------------------------------------------------

export const revisionDiffSchema = z.strictObject({
  revision: z.number().int().min(1),
  summary: z.string().min(1),
  newSources: z.array(z.string()),
  newClaims: z.array(z.string()),
  changedClaims: z.array(z.string()),
});

export type RevisionDiff = z.infer<typeof revisionDiffSchema>;

// -----------------------------------------------------------------------------
// Learning Material Schema & Type (N§2.3: News-to-Learning - quiz, discussion, activities)
// -----------------------------------------------------------------------------

export const quizQuestionSchema = z
  .strictObject({
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    answerIndex: z.number().int().min(0),
    explanation: z.string().min(1),
  })
  .refine((d) => d.answerIndex < d.options.length, {
    message: "answerIndex must be strictly less than options.length",
    path: ["answerIndex"],
  });
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

/**
 * The model often writes an activity as an object ({title, description},
 * {title, instructions}, ...) instead of a string. A plain object (prototype
 * Object.prototype or null) whose values are all strings is joined into one
 * string (non-empty values, key order, ": "). Every other shape, including
 * String objects and class instances, is passed on unchanged and z.string()
 * rejects it.
 */
const activitySchema = z.preprocess((v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const values = Object.values(v);
  if (!values.every((x) => typeof x === "string")) return v;
  return values.filter((x) => x.length > 0).join(": ");
}, z.string().min(1));

export const learningMaterialSchema = z.strictObject({
  audience: z.enum(ARTIFACT_AUDIENCES),
  conceptExplainer: z.string().min(1),
  glossary: z.array(glossaryItemSchema),
  quiz: z.array(quizQuestionSchema),
  discussionQuestions: z.array(z.string().min(1)),
  activities: z.array(activitySchema),
});
export type LearningMaterial = z.infer<typeof learningMaterialSchema>;

// -----------------------------------------------------------------------------
// Policy Impact Explorer Schema & Type (Education: N§3)
// -----------------------------------------------------------------------------

export const policyAudienceImpactSchema = z.strictObject({
  group: z.string().min(1),
  impact: z.string().min(1),
});
export type PolicyAudienceImpact = z.infer<typeof policyAudienceImpactSchema>;

export const policyTimelineMilestoneSchema = z.strictObject({
  phase: z.string().min(1),
  milestone: z.string().min(1),
});
export type PolicyTimelineMilestone = z.infer<
  typeof policyTimelineMilestoneSchema
>;

export const policyImpactExplorerSchema = z.strictObject({
  policyName: z.string().min(1),
  summary: z.string().min(1),
  affectedAudiences: z.array(policyAudienceImpactSchema),
  timeline: z.array(policyTimelineMilestoneSchema),
  remainingUncertainties: z.array(z.string().min(1)),
});
export type PolicyImpactExplorer = z.infer<typeof policyImpactExplorerSchema>;

// -----------------------------------------------------------------------------
// Classroom Discussion Builder Schema & Type (Education: N§3)
// -----------------------------------------------------------------------------

export const classroomDiscussionQuestionSchema = z.strictObject({
  question: z.string().min(1),
  learningGoal: z.string().min(1),
});
export type ClassroomDiscussionQuestion = z.infer<
  typeof classroomDiscussionQuestionSchema
>;

export const classroomActivitySchema = z.strictObject({
  activity: z.string().min(1),
  instructions: z.string().min(1),
});
export type ClassroomActivity = z.infer<typeof classroomActivitySchema>;

export const classroomDiscussionBuilderSchema = z.strictObject({
  topic: z.string().min(1),
  gradeLevels: z.array(z.string().min(1)),
  discussionQuestions: z.array(classroomDiscussionQuestionSchema),
  classroomActivities: z.array(classroomActivitySchema),
});
export type ClassroomDiscussionBuilder = z.infer<
  typeof classroomDiscussionBuilderSchema
>;

// -----------------------------------------------------------------------------
// Education Evidence Checker Schema & Type (Education: N§3)
// -----------------------------------------------------------------------------

export const educationStudyDesignSchema = z.strictObject({
  samplePopulation: z.string().min(1),
  comparisonGroup: z.string().min(1),
  metricUsed: z.string().min(1),
});
export type EducationStudyDesign = z.infer<typeof educationStudyDesignSchema>;

export const educationEvidenceCheckerSchema = z.strictObject({
  subject: z.string().min(1),
  claimedOutcomes: z.string().min(1),
  measuredOutcomes: z.string().min(1),
  studyDesign: educationStudyDesignSchema,
  promotionalGap: z.string().min(1),
  limitations: z.array(z.string().min(1)),
});
export type EducationEvidenceChecker = z.infer<
  typeof educationEvidenceCheckerSchema
>;

// -----------------------------------------------------------------------------
// AI-in-Finance Reality Check Schema & Type (Finance: N§3 & N§4)
// -----------------------------------------------------------------------------

export const FINANCE_CLAIM_TYPES = [
  "announcement",
  "pilot",
  "backtest",
  "live_deployment",
  "regulatory_finding",
] as const;
export type FinanceClaimType = (typeof FINANCE_CLAIM_TYPES)[number];

export const financeRealityCheckSchema = z.strictObject({
  claimant: z.string().min(1),
  claimSummary: z.string().min(1),
  claimType: z.enum(FINANCE_CLAIM_TYPES),
  testPeriodAndBenchmark: z.string().min(1),
  costsAndAssumptions: z.string().min(1),
  disclosedCautions: z.array(z.string().min(1)),
});
export type FinanceRealityCheck = z.infer<typeof financeRealityCheckSchema>;

// -----------------------------------------------------------------------------
// Regulation Watch Schema & Type (Finance: N§3 & N§4)
// -----------------------------------------------------------------------------

export const regulationWatchSchema = z.strictObject({
  regulator: z.string().min(1),
  actionTitle: z.string().min(1),
  summary: z.string().min(1),
  affectedInstitutions: z.array(z.string().min(1)),
  keyRequirements: z.array(z.string().min(1)),
  effectiveDate: z.string().min(1),
  enforcementContext: z.string().min(1),
});
export type RegulationWatch = z.infer<typeof regulationWatchSchema>;

// -----------------------------------------------------------------------------
// Finance Concepts for Learners Schema & Type (Finance: N§3)
// -----------------------------------------------------------------------------

export const financeConceptExplainerSchema = z.strictObject({
  conceptName: z.string().min(1),
  plainEnglishDefinition: z.string().min(1),
  applicationInStory: z.string().min(1),
  commonPitfalls: z.array(z.string().min(1)),
  keyTakeaways: z.array(z.string().min(1)),
});
export type FinanceConceptExplainer = z.infer<
  typeof financeConceptExplainerSchema
>;

// -----------------------------------------------------------------------------
// Skills and Career Trends Schema & Type (Industry: N§3)
// -----------------------------------------------------------------------------

export const occupationImpactSchema = z.strictObject({
  role: z.string().min(1),
  impact: z.string().min(1),
});
export type OccupationImpact = z.infer<typeof occupationImpactSchema>;

export const skillsCareerTrendsSchema = z.strictObject({
  industryShift: z.string().min(1),
  emergingSkills: z.array(z.string().min(1)),
  decliningOrAtRiskSkills: z.array(z.string().min(1)),
  affectedOccupations: z.array(occupationImpactSchema),
  trainingRecommendations: z.array(z.string().min(1)),
});
export type SkillsCareerTrends = z.infer<typeof skillsCareerTrendsSchema>;

// -----------------------------------------------------------------------------
// Industry Impact Report Schema & Type (Newsren §2.4)
// -----------------------------------------------------------------------------

export const impactCitationSchema = z.strictObject({
  claimId: z.number().int().positive().optional(),
  articleId: z.number().int().positive().optional(),
  sourceDomain: z.string().min(1).optional(),
  quote: z.string().min(1).optional(),
});
export type ImpactCitation = z.infer<typeof impactCitationSchema>;

export const industryImpactItemSchema = z
  .strictObject({
    industry: z.string().min(1),
    impact: z.string().min(1),
    transmissionPath: z.string().min(1),
    basis: z.enum(["evidence_based", "speculative"]),
    citation: impactCitationSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.basis === "evidence_based") {
      if (!val.citation || (!val.citation.claimId && !val.citation.quote)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Evidence-based industry impact items must provide a citation with claimId or quote.",
          path: ["citation"],
        });
      }
    }
  });
export type IndustryImpactItem = z.infer<typeof industryImpactItemSchema>;

export const occupationImpactItemSchema = z
  .strictObject({
    role: z.string().min(1),
    impact: z.string().min(1),
    timeframe: z.enum(["immediate", "short_term", "long_term"]),
    basis: z.enum(["evidence_based", "speculative"]),
    citation: impactCitationSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.basis === "evidence_based") {
      if (!val.citation || (!val.citation.claimId && !val.citation.quote)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Evidence-based occupation impact items must provide a citation with claimId or quote.",
          path: ["citation"],
        });
      }
    }
  });
export type OccupationImpactItem = z.infer<typeof occupationImpactItemSchema>;

export const decisionImplicationItemSchema = z
  .strictObject({
    decisionMaker: z.string().min(1),
    recommendationOrTradeoff: z.string().min(1),
    basis: z.enum(["evidence_based", "speculative"]),
    citation: impactCitationSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.basis === "evidence_based") {
      if (!val.citation || (!val.citation.claimId && !val.citation.quote)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Evidence-based decision implications must provide a citation with claimId or quote.",
          path: ["citation"],
        });
      }
    }
  });
export type DecisionImplicationItem = z.infer<
  typeof decisionImplicationItemSchema
>;

export const industryImpactReportSchema = z.strictObject({
  summary: z.string().min(1),
  affectedIndustries: z.array(industryImpactItemSchema).min(1),
  affectedOccupations: z.array(occupationImpactItemSchema).min(1),
  decisionImplications: z.array(decisionImplicationItemSchema).min(1),
});
export type IndustryImpactReport = z.infer<typeof industryImpactReportSchema>;

// -----------------------------------------------------------------------------
// Supply-Chain Ripple Map Schema & Type (Newsren §3 Industry)
// -----------------------------------------------------------------------------

export const rippleEffectSchema = z.strictObject({
  target: z.string().min(1),
  effect: z.string().min(1),
  transmissionChannel: z.string().min(1),
  isHypothesis: z.literal(true),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});
export type RippleEffect = z.infer<typeof rippleEffectSchema>;

export const supplyChainRippleMapSchema = z.strictObject({
  focalNode: z.string().min(1),
  upstreamRipples: z.array(rippleEffectSchema),
  downstreamRipples: z.array(rippleEffectSchema),
  keyHypotheses: z.array(z.string().min(1)).min(1),
});
export type SupplyChainRippleMap = z.infer<typeof supplyChainRippleMapSchema>;

// -----------------------------------------------------------------------------
// Earnings Decoder Schema & Type (Newsren §4 Finance, §103, §139)
// -----------------------------------------------------------------------------

export const factCitationSchema = z.strictObject({
  factId: z.number().int().positive().optional(),
  secUrl: z.string().url().optional(),
  quote: z.string().optional(),
  periodEnd: z.string().optional(),
});
export type FactCitation = z.infer<typeof factCitationSchema>;

export const earningsMetricSchema = z.strictObject({
  metricName: z.string().min(1),
  concept: z.string().min(1),
  unit: z.string().min(1),
  reportedValue: z.string().min(1),
  reportedCitation: factCitationSchema,
  priorPeriodValue: z.string().optional(),
  priorPeriodCitation: factCitationSchema.optional(),
  priorYearValue: z.string().optional(),
  priorYearCitation: factCitationSchema.optional(),
  guidanceRange: z
    .strictObject({
      low: z.string().optional(),
      high: z.string().optional(),
      midpoint: z.string().optional(),
      quote: z.string().optional(),
      secUrl: z.string().url().optional(),
    })
    .optional(),
  guidanceComparison: z.enum(["above", "within", "below", "not_provided"]),
  deltaQoQPercent: z.string().optional(),
  deltaYoYPercent: z.string().optional(),
});
export type EarningsMetric = z.infer<typeof earningsMetricSchema>;

export const earningsDecoderSchema = z.strictObject({
  company: z.strictObject({
    ticker: z.string().min(1),
    name: z.string().min(1),
    cik: z.string().min(1),
  }),
  filing: z.strictObject({
    form: z.string().min(1),
    fiscalYear: z.number().int().optional(),
    fiscalPeriod: z.string().min(1).optional(),
    filingDate: z.string().min(1),
    secUrl: z.string().url(),
    accessionNumber: z.string().min(1),
  }),
  metrics: z.array(earningsMetricSchema).min(1),
  executiveSummary: z.string().min(1),
  keyDrivers: z.array(z.string().min(1)).min(1),
  forwardGuidance: z.array(z.string().min(1)).optional(),
  disclaimer: z.string().min(1),
});
export type EarningsDecoder = z.infer<typeof earningsDecoderSchema>;

// -----------------------------------------------------------------------------
// Technology products: Launch Reality Check, Technology Evolution Timeline (N§3)
// -----------------------------------------------------------------------------

export const NOT_STATED_IN_SOURCES = "Not stated in sources";

/**
 * A passage of one approved source article of the event. The model copies
 * 20 to 300 characters; the parser stores every body sentence that copy
 * touches (#144), so the stored text has no upper limit.
 */
export const sourceQuoteSchema = z.strictObject({
  articleId: z.number().int().positive(),
  quote: z.string().min(20),
});
export type SourceQuote = z.infer<typeof sourceQuoteSchema>;

export const LAUNCH_VERDICTS = [
  "independent_support",
  "independent_dispute",
  "no_independent_evidence",
] as const;
export type LaunchVerdict = (typeof LAUNCH_VERDICTS)[number];

export const launchClaimSchema = z.strictObject({
  claim: z.string().min(1).max(300),
  claimQuote: sourceQuoteSchema,
  verdict: z.enum(LAUNCH_VERDICTS),
  independentEvidence: z.array(sourceQuoteSchema).max(2),
});
export type LaunchClaim = z.infer<typeof launchClaimSchema>;

export const launchRealityCheckSchema = z.strictObject({
  subject: z.string().min(1).max(120),
  claimant: z.string().min(1).max(120),
  claims: z.array(launchClaimSchema).min(1).max(5),
});
export type LaunchRealityCheck = z.infer<typeof launchRealityCheckSchema>;

export const TIMELINE_KINDS = [
  "release",
  "evaluation",
  "correction",
  "adoption",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export const TIMELINE_DATE_SOURCES = [
  "stated_in_text",
  "report_published",
] as const;

export const timelineEntrySchema = z.strictObject({
  date: z.string().min(1).max(40),
  dateSource: z.enum(TIMELINE_DATE_SOURCES),
  kind: z.enum(TIMELINE_KINDS),
  description: z.string().min(1).max(300),
  source: sourceQuoteSchema,
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const technologyEvolutionTimelineSchema = z.strictObject({
  entries: z.array(timelineEntrySchema).min(2).max(8),
});
export type TechnologyEvolutionTimeline = z.infer<
  typeof technologyEvolutionTimelineSchema
>;

// -----------------------------------------------------------------------------
// Aggregate view of published event artifacts
// -----------------------------------------------------------------------------

export interface EventArtifactsView {
  brief: StoryBrief | null;
  explanations: Partial<Record<ArtifactAudience, AudienceExplain>>;
  decoder: ResearchPaperDecoder | null;
  revisionDiff?: RevisionDiff | null;
  learningMaterials?: Partial<Record<ArtifactAudience, LearningMaterial>>;
  policyImpact?: PolicyImpactExplorer | null;
  classroomDiscussion?: ClassroomDiscussionBuilder | null;
  educationEvidence?: EducationEvidenceChecker | null;
  financeRealityCheck?: FinanceRealityCheck | null;
  regulationWatch?: RegulationWatch | null;
  financeConcept?: FinanceConceptExplainer | null;
  skillsCareerTrends?: SkillsCareerTrends | null;
  industryImpact?: IndustryImpactReport | null;
  supplyChainRipple?: SupplyChainRippleMap | null;
  earningsDecoder?: EarningsDecoder | null;
  launchRealityCheck?: LaunchRealityCheck | null;
  evolutionTimeline?: TechnologyEvolutionTimeline | null;
}
