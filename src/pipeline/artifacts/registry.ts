import type { ZodType } from "zod";
import {
  type ArtifactAudience,
  type ArtifactType,
  ARTIFACT_AUDIENCES,
  storyBriefSchema,
  audienceExplainSchema,
  researchPaperDecoderSchema,
  learningMaterialSchema,
  policyImpactExplorerSchema,
  classroomDiscussionBuilderSchema,
  educationEvidenceCheckerSchema,
  financeRealityCheckSchema,
  regulationWatchSchema,
  financeConceptExplainerSchema,
  skillsCareerTrendsSchema,
  industryImpactReportSchema,
  supplyChainRippleMapSchema,
  launchRealityCheckSchema,
  technologyEvolutionTimelineSchema,
} from "../../lib/artifacts/types";
import { FINANCE_SLUG } from "../analyze/analyze";
import type { TextRequest } from "../../providers/adapters";
import {
  AUDIENCE_EXPLAIN_PROMPT_VERSION,
  CLASSROOM_DISCUSSION_PROMPT_VERSION,
  EDUCATION_EVIDENCE_PROMPT_VERSION,
  FINANCE_CONCEPT_PROMPT_VERSION,
  FINANCE_REALITY_CHECK_PROMPT_VERSION,
  INDUSTRY_IMPACT_PROMPT_VERSION,
  LEARNING_MATERIAL_PROMPT_VERSION,
  POLICY_IMPACT_PROMPT_VERSION,
  REGULATION_WATCH_PROMPT_VERSION,
  RESEARCH_PAPER_DECODER_PROMPT_VERSION,
  SKILLS_CAREER_PROMPT_VERSION,
  STORY_BRIEF_PROMPT_VERSION,
  SUPPLY_CHAIN_RIPPLE_PROMPT_VERSION,
  EARNINGS_DECODER_PROMPT_VERSION,
  LAUNCH_REALITY_CHECK_PROMPT_VERSION,
  EVOLUTION_TIMELINE_PROMPT_VERSION,
  buildAudienceExplainRequest,
  buildClassroomDiscussionBuilderRequest,
  buildEducationEvidenceCheckerRequest,
  buildFinanceConceptExplainerRequest,
  buildFinanceRealityCheckRequest,
  buildIndustryImpactReportRequest,
  buildLearningMaterialRequest,
  buildPolicyImpactExplorerRequest,
  buildRegulationWatchRequest,
  buildResearchPaperDecoderRequest,
  buildSkillsCareerTrendsRequest,
  buildStoryBriefRequest,
  buildSupplyChainRippleMapRequest,
  buildEarningsDecoderRequest,
  buildLaunchRealityCheckRequest,
  buildEvolutionTimelineRequest,
  parseAudienceExplainOutput,
  parseClassroomDiscussionBuilderOutput,
  parseEducationEvidenceCheckerOutput,
  parseFinanceConceptExplainerOutput,
  parseFinanceRealityCheckOutput,
  parseIndustryImpactReportOutput,
  parseLearningMaterialOutput,
  parsePolicyImpactExplorerOutput,
  parseRegulationWatchOutput,
  parseResearchPaperDecoderOutput,
  parseSkillsCareerTrendsOutput,
  parseStoryBriefOutput,
  parseSupplyChainRippleMapOutput,
  parseEarningsDecoderOutput,
  parseLaunchRealityCheckOutput,
  parseEvolutionTimelineOutput,
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
  slot?: "write" | "reason";
  audiences: readonly (ArtifactAudience | "")[];
  promptVersion: string;
  isEligible: (ctx: ArtifactEligibilityContext) => boolean;
  buildRequest: (
    material: ArtifactEventMaterial,
    audience?: string,
  ) => TextRequest;
  parseOutput: (
    rawText: string,
    audience?: string,
    material?: ArtifactEventMaterial,
  ) => unknown | null;
  /** The schema parseOutput applies to the raw JSON, for diagnosing a null; null when the parser enriches before safeParse. */
  diagnosisSchema: ZodType | null;
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
    diagnosisSchema: storyBriefSchema,
  },

  audience_explain: {
    type: "audience_explain",
    audiences: ARTIFACT_AUDIENCES,
    promptVersion: AUDIENCE_EXPLAIN_PROMPT_VERSION,
    isEligible: (ctx) => {
      // Round 6 full coverage: every event with an approved article.
      return ctx.articles.length > 0;
    },
    buildRequest: (material, audience) => {
      const aud = (audience || "student") as ArtifactAudience;
      return buildAudienceExplainRequest(material, aud);
    },
    parseOutput: (rawText) => parseAudienceExplainOutput(rawText),
    diagnosisSchema: audienceExplainSchema,
  },

  research_paper_decoder: {
    type: "research_paper_decoder",
    audiences: [""],
    promptVersion: RESEARCH_PAPER_DECODER_PROMPT_VERSION,
    isEligible: (ctx) => {
      // Research Paper Decoder requires at least one research paper or arXiv report
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
    diagnosisSchema: researchPaperDecoderSchema,
  },

  learning_material: {
    type: "learning_material",
    audiences: ARTIFACT_AUDIENCES,
    promptVersion: LEARNING_MATERIAL_PROMPT_VERSION,
    isEligible: (ctx) => {
      // Round 6 full coverage: every event with an approved article.
      return ctx.articles.length > 0;
    },
    buildRequest: (material, audience) => {
      const aud = (audience || "student") as ArtifactAudience;
      return buildLearningMaterialRequest(material, aud);
    },
    parseOutput: (rawText) => parseLearningMaterialOutput(rawText),
    diagnosisSchema: learningMaterialSchema,
  },

  policy_impact_explorer: {
    type: "policy_impact_explorer",
    audiences: [""],
    promptVersion: POLICY_IMPACT_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== "education") return false;
      if (ctx.articles.length === 0) return false;
      return ctx.articles.some(
        (a) =>
          a.contentType === "policy_change" ||
          a.evidenceTags.includes("regulatory_finding"),
      );
    },
    buildRequest: (material) => buildPolicyImpactExplorerRequest(material),
    parseOutput: (rawText) => parsePolicyImpactExplorerOutput(rawText),
    diagnosisSchema: policyImpactExplorerSchema,
  },

  classroom_discussion_builder: {
    type: "classroom_discussion_builder",
    audiences: [""],
    promptVersion: CLASSROOM_DISCUSSION_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== "education") return false;
      return ctx.articles.length > 0;
    },
    buildRequest: (material) =>
      buildClassroomDiscussionBuilderRequest(material),
    parseOutput: (rawText) => parseClassroomDiscussionBuilderOutput(rawText),
    diagnosisSchema: classroomDiscussionBuilderSchema,
  },

  education_evidence_checker: {
    type: "education_evidence_checker",
    audiences: [""],
    promptVersion: EDUCATION_EVIDENCE_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== "education") return false;
      if (ctx.articles.length === 0) return false;
      return ctx.articles.some(
        (a) =>
          a.contentType === "research_study" ||
          a.contentType === "tool_or_product" ||
          a.evidenceTags.includes("peer_reviewed") ||
          a.evidenceTags.includes("test_scores"),
      );
    },
    buildRequest: (material) => buildEducationEvidenceCheckerRequest(material),
    parseOutput: (rawText) => parseEducationEvidenceCheckerOutput(rawText),
    diagnosisSchema: educationEvidenceCheckerSchema,
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
      return ctx.articles.some(
        (a) =>
          a.contentType === "ai_in_finance_claim" ||
          a.evidenceTags.includes("backtest") ||
          a.evidenceTags.includes("simulated"),
      );
    },
    buildRequest: (material) => buildFinanceRealityCheckRequest(material),
    parseOutput: (rawText) => parseFinanceRealityCheckOutput(rawText),
    diagnosisSchema: financeRealityCheckSchema,
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
      return ctx.articles.some(
        (a) =>
          a.contentType === "regulatory_action" ||
          a.evidenceTags.includes("regulatory_finding"),
      );
    },
    buildRequest: (material) => buildRegulationWatchRequest(material),
    parseOutput: (rawText) => parseRegulationWatchOutput(rawText),
    diagnosisSchema: regulationWatchSchema,
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
    diagnosisSchema: financeConceptExplainerSchema,
  },

  skills_career_trends: {
    type: "skills_career_trends",
    audiences: [""],
    promptVersion: SKILLS_CAREER_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.industrySlug !== "industry") return false;
      if (ctx.articles.length === 0) return false;
      return ctx.articles.some(
        (a) =>
          a.contentType === "market_trend" || a.contentType === "company_move",
      );
    },
    buildRequest: (material) => buildSkillsCareerTrendsRequest(material),
    parseOutput: (rawText) => parseSkillsCareerTrendsOutput(rawText),
    diagnosisSchema: skillsCareerTrendsSchema,
  },

  industry_impact_report: {
    type: "industry_impact_report",
    audiences: [""],
    promptVersion: INDUSTRY_IMPACT_PROMPT_VERSION,
    isEligible: (ctx) => {
      if (ctx.articles.length === 0) return false;
      // Industry vertical deep intelligence, or cross-vertical breakthrough/macro moves
      if (ctx.industrySlug === "industry") {
        return true;
      }
      return (
        ctx.eventScore >= ctx.deepThreshold &&
        ctx.articles.some(
          (a) =>
            a.contentType === "market_trend" ||
            a.contentType === "company_move" ||
            a.contentType === "industry_event" ||
            a.contentType === "tool_or_product",
        )
      );
    },
    buildRequest: (material) => buildIndustryImpactReportRequest(material),
    parseOutput: (rawText, _aud, material) =>
      parseIndustryImpactReportOutput(rawText, material),
    diagnosisSchema: industryImpactReportSchema,
  },

  supply_chain_ripple_map: {
    type: "supply_chain_ripple_map",
    audiences: [""],
    promptVersion: SUPPLY_CHAIN_RIPPLE_PROMPT_VERSION,
    isEligible: (ctx) => {
      // Newsren §3: Industry vertical exclusive feature
      if (ctx.industrySlug !== "industry") return false;
      if (ctx.articles.length === 0) return false;
      return ctx.articles.some(
        (a) =>
          a.contentType === "supply_chain" ||
          a.contentType === "market_trend" ||
          a.contentType === "company_move" ||
          a.contentType === "tool_or_product" ||
          a.evidenceTags.includes("supply_chain") ||
          a.evidenceTags.includes("hardware"),
      );
    },
    buildRequest: (material) => buildSupplyChainRippleMapRequest(material),
    parseOutput: (rawText) => parseSupplyChainRippleMapOutput(rawText),
    diagnosisSchema: supplyChainRippleMapSchema,
  },

  earnings_decoder: {
    type: "earnings_decoder",
    slot: "reason",
    audiences: [""],
    promptVersion: EARNINGS_DECODER_PROMPT_VERSION,
    isEligible: (ctx) => {
      // Newsren §4 Finance vertical exclusive feature
      if (ctx.industrySlug !== FINANCE_SLUG) return false;
      return ctx.articles.some(
        (a) =>
          a.sourceDomain.includes("sec.gov") ||
          a.contentType === "earnings_report" ||
          a.contentType === "sec_filing" ||
          a.evidenceTags.includes("sec_filing") ||
          a.evidenceTags.includes("financial_results"),
      );
    },
    buildRequest: (material) => buildEarningsDecoderRequest(material),
    parseOutput: (rawText, _aud, material) =>
      parseEarningsDecoderOutput(rawText, material),
    diagnosisSchema: null,
  },

  launch_reality_check: {
    type: "launch_reality_check",
    audiences: [""],
    promptVersion: LAUNCH_REALITY_CHECK_PROMPT_VERSION,
    isEligible: (ctx) => {
      // N§3 Technology: a company's claimed capabilities vs independent benchmarks
      if (ctx.industrySlug !== "technology") return false;
      return ctx.articles.some(
        (a) =>
          a.contentType === "model_release" ||
          a.contentType === "product_launch",
      );
    },
    buildRequest: (material) => buildLaunchRealityCheckRequest(material),
    parseOutput: (rawText, _aud, material) =>
      parseLaunchRealityCheckOutput(rawText, material),
    diagnosisSchema: launchRealityCheckSchema,
  },

  technology_evolution_timeline: {
    type: "technology_evolution_timeline",
    audiences: [""],
    promptVersion: EVOLUTION_TIMELINE_PROMPT_VERSION,
    isEligible: (ctx) => {
      // N§3 Technology: connect milestones across the reports of one story
      if (ctx.industrySlug !== "technology") return false;
      return ctx.articles.length >= 2;
    },
    buildRequest: (material) => buildEvolutionTimelineRequest(material),
    parseOutput: (rawText, _aud, material) =>
      parseEvolutionTimelineOutput(rawText, material),
    diagnosisSchema: technologyEvolutionTimelineSchema,
  },
};
