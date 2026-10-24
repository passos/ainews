import {
  type ArtifactAudience,
  type ArtifactType,
  ARTIFACT_AUDIENCES,
} from "../../lib/artifacts/types";
import type { TextRequest } from "../../providers/adapters";
import {
  AUDIENCE_EXPLAIN_PROMPT_VERSION,
  buildAudienceExplainRequest,
  buildResearchPaperDecoderRequest,
  buildStoryBriefRequest,
  parseAudienceExplainOutput,
  parseResearchPaperDecoderOutput,
  parseStoryBriefOutput,
  RESEARCH_PAPER_DECODER_PROMPT_VERSION,
  STORY_BRIEF_PROMPT_VERSION,
  type ArtifactEventMaterial,
} from "./prompts";

export interface ArticleMetadata {
  id: number;
  sourceDomain: string;
  contentType: string | null;
  evidenceTags: string[];
}

export interface ArtifactEligibilityContext {
  eventScore: number;
  selectThreshold: number;
  deepThreshold: number;
  articles: ArticleMetadata[];
}

export interface ArtifactDefinition {
  type: ArtifactType;
  audiences: readonly (ArtifactAudience | "")[];
  promptVersion: string;
  isEligible: (ctx: ArtifactEligibilityContext) => boolean;
  buildRequest: (
    material: ArtifactEventMaterial,
    audience?: string,
  ) => TextRequest;
  parseOutput: (rawText: string, audience?: string) => unknown | null;
}

export const ARTIFACT_REGISTRY: Record<ArtifactType, ArtifactDefinition> = {
  story_brief: {
    type: "story_brief",
    audiences: [""],
    promptVersion: STORY_BRIEF_PROMPT_VERSION,
    isEligible: (ctx) => {
      // Story Brief is standard for all events with approved articles
      return ctx.articles.length > 0;
    },
    buildRequest: (material) => buildStoryBriefRequest(material),
    parseOutput: (rawText) => parseStoryBriefOutput(rawText),
  },

  audience_explain: {
    type: "audience_explain",
    audiences: ARTIFACT_AUDIENCES,
    promptVersion: AUDIENCE_EXPLAIN_PROMPT_VERSION,
    isEligible: (ctx) => {
      // Three-tier explanations require the event score to meet or exceed the deep threshold
      return ctx.articles.length > 0 && ctx.eventScore >= ctx.deepThreshold;
    },
    buildRequest: (material, audience) => {
      const aud = (audience || "student") as ArtifactAudience;
      return buildAudienceExplainRequest(material, aud);
    },
    parseOutput: (rawText) => parseAudienceExplainOutput(rawText),
  },

  research_paper_decoder: {
    type: "research_paper_decoder",
    audiences: [""],
    promptVersion: RESEARCH_PAPER_DECODER_PROMPT_VERSION,
    isEligible: (ctx) => {
      // Research Paper Decoder requires:
      // 1. Event score >= deepThreshold
      // 2. Contains at least one research paper or arXiv report
      if (ctx.eventScore < ctx.deepThreshold) return false;
      return ctx.articles.some((a) => {
        const isArxiv = a.sourceDomain.toLowerCase().includes("arxiv");
        const isPaperType = a.contentType === "research_paper";
        const hasPaperTag =
          Array.isArray(a.evidenceTags) &&
          (a.evidenceTags.includes("paper_preprint") ||
            a.evidenceTags.includes("peer_reviewed"));
        return isArxiv || isPaperType || hasPaperTag;
      });
    },
    buildRequest: (material) => buildResearchPaperDecoderRequest(material),
    parseOutput: (rawText) => parseResearchPaperDecoderOutput(rawText),
  },
};
