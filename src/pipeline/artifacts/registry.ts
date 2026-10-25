import {
  type ArtifactAudience,
  type ArtifactType,
  ARTIFACT_AUDIENCES,
} from "../../lib/artifacts/types";
import { FINANCE_SLUG } from "../analyze/analyze";
import type { TextRequest } from "../../providers/adapters";
import {
  AUDIENCE_EXPLAIN_PROMPT_VERSION,
  CLASSROOM_DISCUSSION_PROMPT_VERSION,
  EDUCATION_EVIDENCE_PROMPT_VERSION,
  FINANCE_CONCEPT_PROMPT_VERSION,
  FINANCE_REALITY_CHECK_PROMPT_VERSION,
  LEARNING_MATERIAL_PROMPT_VERSION,
  POLICY_IMPACT_PROMPT_VERSION,
  REGULATION_WATCH_PROMPT_VERSION,
  RESEARCH_PAPER_DECODER_PROMPT_VERSION,
  SKILLS_CAREER_PROMPT_VERSION,
  STORY_BRIEF_PROMPT_VERSION,
  buildAudienceExplainRequest,
  buildClassroomDiscussionBuilderRequest,
  buildEducationEvidenceCheckerRequest,
  buildFinanceConceptExplainerRequest,
  buildFinanceRealityCheckRequest,
  buildLearningMaterialRequest,
  buildPolicyImpactExplorerRequest,
  buildRegulationWatchRequest,
  buildResearchPaperDecoderRequest,
  buildSkillsCareerTrendsRequest,
  buildStoryBriefRequest,
  parseAudienceExplainOutput,
  parseClassroomDiscussionBuilderOutput,
  parseEducationEvidenceCheckerOutput,
  parseFinanceConceptExplainerOutput,
  parseFinanceRealityCheckOutput,
  parseLearningMaterialOutput,
  parsePolicyImpactExplorerOutput,
  parseRegulationWatchOutput,
  parseResearchPaperDecoderOutput,
  parseSkillsCareerTrendsOutput,
  parseStoryBriefOutput,
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
  industrySlug: string;
  industryName: string;
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

export const ARTIFACT_REGISTRY: Record<
  Exclude<ArtifactType, "revision_diff">,
  ArtifactDefinition
> = {
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
          (a.evidenceTags.includes("preprint") ||
            a.evidenceTags.includes("peer_reviewed"));
        return isArxiv || isPaperType || hasPaperTag;
      });
    },
    buildRequest: (material) => buildResearchPaperDecoderRequest(material),
    parseOutput: (rawText) => parseResearchPaperDecoderOutput(rawText),
  },

  learning_material: {
    type: "learning_material",
    audiences: ARTIFACT_AUDIENCES,
    promptVersion: LEARNING_MATERIAL_PROMPT_VERSION,
    isEligible: (ctx) => {
      // News-to-Learning materials are generated for deep events across all verticals
      return ctx.articles.length > 0 && ctx.eventScore >= ctx.deepThreshold;
    },
    buildRequest: (material, audience) => {
      const aud = (audience || "student") as ArtifactAudience;
      return buildLearningMaterialRequest(material, aud);
    },
    parseOutput: (rawText) => parseLearningMaterialOutput(rawText),
  },

  policy_impact_explorer: {
    type: "policy_impact_explorer",
    audiences: [""],
    promptVersion: POLICY_IMPACT_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== "education") return false;
      if (ctx.articles.length === 0 || ctx.eventScore < ctx.selectThreshold) {
        return false;
      }
      return (
        ctx.eventScore >= ctx.deepThreshold ||
        ctx.articles.some(
          (a) =>
            a.contentType === "policy_change" ||
            a.evidenceTags.includes("regulatory_finding"),
        )
      );
    },
    buildRequest: (material) => buildPolicyImpactExplorerRequest(material),
    parseOutput: (rawText) => parsePolicyImpactExplorerOutput(rawText),
  },

  classroom_discussion_builder: {
    type: "classroom_discussion_builder",
    audiences: [""],
    promptVersion: CLASSROOM_DISCUSSION_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== "education") return false;
      return ctx.articles.length > 0 && ctx.eventScore >= ctx.selectThreshold;
    },
    buildRequest: (material) =>
      buildClassroomDiscussionBuilderRequest(material),
    parseOutput: (rawText) => parseClassroomDiscussionBuilderOutput(rawText),
  },

  education_evidence_checker: {
    type: "education_evidence_checker",
    audiences: [""],
    promptVersion: EDUCATION_EVIDENCE_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== "education") return false;
      if (ctx.articles.length === 0 || ctx.eventScore < ctx.selectThreshold) {
        return false;
      }
      return (
        ctx.eventScore >= ctx.deepThreshold ||
        ctx.articles.some(
          (a) =>
            a.contentType === "research_study" ||
            a.contentType === "tool_or_product" ||
            a.evidenceTags.includes("peer_reviewed") ||
            a.evidenceTags.includes("test_scores"),
        )
      );
    },
    buildRequest: (material) => buildEducationEvidenceCheckerRequest(material),
    parseOutput: (rawText) => parseEducationEvidenceCheckerOutput(rawText),
  },

  finance_reality_check: {
    type: "finance_reality_check",
    audiences: [""],
    promptVersion: FINANCE_REALITY_CHECK_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== FINANCE_SLUG) return false;
      if (ctx.articles.length === 0 || ctx.eventScore < ctx.selectThreshold) {
        return false;
      }
      return (
        ctx.eventScore >= ctx.deepThreshold ||
        ctx.articles.some(
          (a) =>
            a.contentType === "ai_in_finance_claim" ||
            a.evidenceTags.includes("backtest") ||
            a.evidenceTags.includes("simulated"),
        )
      );
    },
    buildRequest: (material) => buildFinanceRealityCheckRequest(material),
    parseOutput: (rawText) => parseFinanceRealityCheckOutput(rawText),
  },

  regulation_watch: {
    type: "regulation_watch",
    audiences: [""],
    promptVersion: REGULATION_WATCH_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== FINANCE_SLUG) return false;
      if (ctx.articles.length === 0 || ctx.eventScore < ctx.selectThreshold) {
        return false;
      }
      return (
        ctx.eventScore >= ctx.deepThreshold ||
        ctx.articles.some(
          (a) =>
            a.contentType === "regulatory_action" ||
            a.evidenceTags.includes("regulatory_finding"),
        )
      );
    },
    buildRequest: (material) => buildRegulationWatchRequest(material),
    parseOutput: (rawText) => parseRegulationWatchOutput(rawText),
  },

  finance_concept_explainer: {
    type: "finance_concept_explainer",
    audiences: [""],
    promptVersion: FINANCE_CONCEPT_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== FINANCE_SLUG) return false;
      return ctx.articles.length > 0 && ctx.eventScore >= ctx.selectThreshold;
    },
    buildRequest: (material) => buildFinanceConceptExplainerRequest(material),
    parseOutput: (rawText) => parseFinanceConceptExplainerOutput(rawText),
  },

  skills_career_trends: {
    type: "skills_career_trends",
    audiences: [""],
    promptVersion: SKILLS_CAREER_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== "industry") return false;
      if (ctx.articles.length === 0 || ctx.eventScore < ctx.selectThreshold) {
        return false;
      }
      return (
        ctx.eventScore >= ctx.deepThreshold ||
        ctx.articles.some(
          (a) =>
            a.contentType === "market_trend" ||
            a.contentType === "company_move",
        )
      );
    },
    buildRequest: (material) => buildSkillsCareerTrendsRequest(material),
    parseOutput: (rawText) => parseSkillsCareerTrendsOutput(rawText),
  },
};
