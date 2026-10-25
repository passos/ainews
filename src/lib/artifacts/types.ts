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

export const quizQuestionSchema = z.strictObject({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2),
  answerIndex: z.number().int().min(0),
  explanation: z.string().min(1),
});
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

export const learningMaterialSchema = z.strictObject({
  audience: z.enum(ARTIFACT_AUDIENCES),
  conceptExplainer: z.string().min(1),
  glossary: z.array(glossaryItemSchema),
  quiz: z.array(quizQuestionSchema),
  discussionQuestions: z.array(z.string().min(1)),
  activities: z.array(z.string().min(1)),
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
}
