import { z } from "zod";

export const ARTIFACT_TYPES = [
  "story_brief",
  "audience_explain",
  "research_paper_decoder",
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
// Aggregate view of published event artifacts
// -----------------------------------------------------------------------------

export interface EventArtifactsView {
  brief: StoryBrief | null;
  explanations: Partial<Record<ArtifactAudience, AudienceExplain>>;
  decoder: ResearchPaperDecoder | null;
}
