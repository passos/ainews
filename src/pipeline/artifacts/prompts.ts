import type { ZodType } from "zod";
import {
  type AudienceExplain,
  type ClassroomDiscussionBuilder,
  type EducationEvidenceChecker,
  type FinanceConceptExplainer,
  type FinanceRealityCheck,
  type IndustryImpactReport,
  type LearningMaterial,
  type PolicyImpactExplorer,
  type RegulationWatch,
  type ResearchPaperDecoder,
  type SkillsCareerTrends,
  type StoryBrief,
  type SupplyChainRippleMap,
  type EarningsDecoder,
  type EarningsMetric,
  type LaunchRealityCheck,
  type SourceQuote,
  type TechnologyEvolutionTimeline,
  audienceExplainSchema,
  classroomDiscussionBuilderSchema,
  educationEvidenceCheckerSchema,
  earningsDecoderSchema,
  financeConceptExplainerSchema,
  financeRealityCheckSchema,
  industryImpactReportSchema,
  learningMaterialSchema,
  policyImpactExplorerSchema,
  regulationWatchSchema,
  researchPaperDecoderSchema,
  skillsCareerTrendsSchema,
  storyBriefSchema,
  supplyChainRippleMapSchema,
  launchRealityCheckSchema,
  technologyEvolutionTimelineSchema,
  NOT_STATED_IN_SOURCES,
} from "../../lib/artifacts/types";
import type { TextRequest } from "../../providers/adapters";
import { WRITE_THINKING } from "../analyze/prompts";
import { localDate } from "../../lib/time";
import {
  groundedSentences,
  normalizeSourceText,
  sourceTextContains,
} from "../../lib/artifacts/grounding";

export const STORY_BRIEF_PROMPT_VERSION = "brief-v1";
export const AUDIENCE_EXPLAIN_PROMPT_VERSION = "explain-v1";
export const RESEARCH_PAPER_DECODER_PROMPT_VERSION = "decoder-v1";
export const LEARNING_MATERIAL_PROMPT_VERSION = "learning-material-v1";
export const POLICY_IMPACT_PROMPT_VERSION = "policy-impact-v1";
export const CLASSROOM_DISCUSSION_PROMPT_VERSION = "classroom-discussion-v1";
export const EDUCATION_EVIDENCE_PROMPT_VERSION = "education-evidence-v1";
export const FINANCE_REALITY_CHECK_PROMPT_VERSION = "finance-reality-check-v1";
export const REGULATION_WATCH_PROMPT_VERSION = "regulation-watch-v1";
export const FINANCE_CONCEPT_PROMPT_VERSION = "finance-concept-v1";
export const SKILLS_CAREER_PROMPT_VERSION = "skills-career-v1";
export const INDUSTRY_IMPACT_PROMPT_VERSION = "industry-impact-v1";
export const SUPPLY_CHAIN_RIPPLE_PROMPT_VERSION = "supply-chain-ripple-v1";
export const EARNINGS_DECODER_PROMPT_VERSION = "earnings-decoder-v1";

export const BRIEF_MAX_OUTPUT_TOKENS = 1500;
export const EXPLAIN_MAX_OUTPUT_TOKENS = 2000;
export const DECODER_MAX_OUTPUT_TOKENS = 2500;
export const LEARNING_MATERIAL_MAX_OUTPUT_TOKENS = 2500;
export const VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS = 2000;
export const LAUNCH_REALITY_CHECK_PROMPT_VERSION = "launch-reality-check-v1";
export const EVOLUTION_TIMELINE_PROMPT_VERSION = "evolution-timeline-v1";
/** Worst case about 1,900 output tokens plus 500 for thinking, times 1.25 (#131 D4). */
export const TECH_PRODUCT_MAX_OUTPUT_TOKENS = 3000;

export interface ArtifactArticleMaterial {
  id: number;
  title: string;
  sourceName: string;
  sourceDomain: string;
  publishedAt: number | null;
  summary: string | null;
  bodyText?: string | null;
  /**
   * The stored source body only, or null when R2 has none. `bodyText` falls
   * back to the summary; quotes are checked against this field instead.
   * Prompts do not read it, so request bytes do not depend on it.
   */
  sourceBodyText: string | null;
  /**
   * articles.canonical_url. Its host decides whether two articles come from
   * the same outlet. Prompts and inputSha do not read it.
   */
  canonicalUrl: string;
}

export interface ArtifactVerifiedClaim {
  id: number;
  claimText: string;
  claimType: string;
  consensusStatus: string;
  realityCheck?: string;
}

export interface ArtifactFinancialFactMaterial {
  id: number;
  taxonomy: string;
  concept: string;
  unit: string;
  val: string;
  periodStart?: string | null;
  periodEnd: string;
  fiscalYear?: number | null;
  fiscalPeriod?: string | null;
  secUrl: string;
}

export interface ArtifactFilingMaterial {
  id: number;
  accessionNumber: string;
  form: string;
  filingDate: string;
  reportDate?: string | null;
  secUrl: string;
  fiscalYear?: number | null;
  fiscalPeriod?: string | null;
  companyTicker: string;
  companyName: string;
  companyCik: string;
}

export interface ArtifactEventMaterial {
  eventId: number;
  eventTitle: string;
  industryName: string;
  industrySlug: string;
  disclaimer?: string | null;
  articles: ArtifactArticleMaterial[];
  verifiedClaims?: ArtifactVerifiedClaim[];
  financialFacts?: ArtifactFinancialFactMaterial[];
  filing?: ArtifactFilingMaterial;
  calculatedMetrics?: EarningsMetric[];
}

function formatArticlesContext(
  articles: ArtifactArticleMaterial[],
  maxBodyCharsPerArticle = 4000,
): string {
  return articles
    .map((a, idx) => {
      const parts = [
        `Article ${idx + 1}: [ID: ${a.id}] ${a.title}`,
        `Source: ${a.sourceName} (${a.sourceDomain})`,
      ];
      if (a.summary) {
        parts.push(`Summary: ${a.summary}`);
      }
      if (a.bodyText) {
        const truncated =
          a.bodyText.length > maxBodyCharsPerArticle
            ? a.bodyText.slice(0, maxBodyCharsPerArticle) +
              "\n...[text truncated]..."
            : a.bodyText;
        parts.push(`Content:\n${truncated}`);
      }
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

function formatVerifiedClaimsContext(claims?: ArtifactVerifiedClaim[]): string {
  if (!claims || claims.length === 0) {
    return "No verified claims recorded for this event yet.";
  }
  return claims
    .map(
      (c) =>
        `- [Claim ID: ${c.id}] (${c.claimType}, consensus: ${c.consensusStatus}${c.realityCheck ? `, reality: ${c.realityCheck}` : ""}): "${c.claimText}"`,
    )
    .join("\n");
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/** Why an artifact parser returned null, safe to log: never model text. */
export type ArtifactRejection =
  | { path: (string | number)[]; code: string }[]
  | "invalid_json"
  | "unavailable";

/**
 * Re-runs the parser's first two steps on `rawText`. `[]` means the schema
 * accepts the text and the parser rejected it for another reason. Only
 * `path` and `code` are kept: `message`, `keys` and the JSON.parse error
 * can contain model text.
 */
export function diagnoseArtifactRejection(
  rawText: string,
  schema: ZodType | null,
): ArtifactRejection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch {
    return "invalid_json";
  }
  if (!schema) return "unavailable";
  const res = schema.safeParse(parsed);
  if (res.success) return [];
  return res.error.issues.map((issue) => ({
    path: issue.path.map((p) => (typeof p === "number" ? p : String(p))),
    code: issue.code,
  }));
}

// -----------------------------------------------------------------------------
// Story Brief
// -----------------------------------------------------------------------------

export function buildStoryBriefRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are an investigative news intelligence analyst for Personal News (${material.industryName}).`,
    "Synthesize an evidence-grounded Story Brief for the evolving story below.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "whatHappened": "Clear, factual account of what occurred across the reported developments. Distinguish facts from claims.",
  "whatIsNew": "What is substantively new or changing in this story compared to prior baselines or routine activity.",
  "whatEvidenceExists": "The documented evidence supporting this story: test results, independent benchmarks, papers, filings, statements, or pilot findings. Note any disputes or missing validation.",
  "whatToWatchNext": "Upcoming decisions, evaluations, adoption milestones, regulatory reviews, or market reactions to observe next."
}`,
    "Rules:",
    "- Rely strictly on the provided articles. Do not hallucinate benchmarks, quotes, or unmentioned facts.",
    "- Be concise, disciplined, and objective. Output valid JSON only, without markdown code fences or conversational preamble.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: BRIEF_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseStoryBriefOutput(rawText: string): StoryBrief | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = storyBriefSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Audience Explain (Student / Educator / Professional)
// -----------------------------------------------------------------------------

export function buildAudienceExplainRequest(
  material: ArtifactEventMaterial,
  audience: "student" | "educator" | "professional",
): TextRequest {
  const audienceTone =
    audience === "student"
      ? "Focus on conceptual clarity, relatable analogies, foundational context, and plain language explanations. Define any technical terms clearly."
      : audience === "educator"
        ? "Focus on instructional significance, pedagogical context, classroom discussion angles, and curricular relevance for educators and instructors."
        : "Focus on operational impact, strategic trade-offs, architecture/technical nuances, and practitioner considerations.";

  const system = [
    `You are an expert educational writer for Personal News (${material.industryName}).`,
    `Adapt the verified developments into a News-to-Learning explainer tailored specifically for: ${audience.toUpperCase()}.`,
    `Audience guidelines: ${audienceTone}`,
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "audience": "${audience}",
  "overview": "A comprehensive 2-3 paragraph explainer adapted for this audience.",
  "keyPoints": [
    "3-5 distinct bullet points explaining key aspects of this development"
  ],
  "implications": [
    "2-4 concrete takeaways, practical impacts, or discussion questions for this audience"
  ],
  "glossary": [
    {
      "term": "Key technical or industry term",
      "definition": "Clear, accessible definition in context"
    }
  ]
}`,
    "Rules:",
    "- Base all technical explanations on the verified facts in the text.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: EXPLAIN_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseAudienceExplainOutput(
  rawText: string,
): AudienceExplain | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = audienceExplainSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Research Paper Decoder
// -----------------------------------------------------------------------------

export function buildResearchPaperDecoderRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a senior scientific research editor for Personal News (${material.industryName}).`,
    "Explain the research paper(s) in this story according to the five-section Research Paper Decoder framework.",
    `Produce a JSON object matching this schema:
{
  "hypothesis": "The core research question, hypothesis, or theoretical problem the authors investigate.",
  "method": "The technical methodology, architecture, dataset, and baseline evaluations. If not specified in available text, explicitly write 'Not specified in available text'.",
  "findings": "Key empirical findings, benchmark results, and measured improvements over prior methods.",
  "limitations": "Known constraints, assumptions, computational costs, failure modes, or caveats acknowledged by the authors.",
  "applications": "Realistic downstream engineering or product applications enabled by this research."
}`,
    "Rules:",
    "- Do not invent methodology details or benchmarks not present in the text.",
    "- If certain details were not included in the article/abstract, explicitly state that.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports (including research paper text/abstract):",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: DECODER_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseResearchPaperDecoderOutput(
  rawText: string,
): ResearchPaperDecoder | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = researchPaperDecoderSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Learning Material (News-to-Learning, N§2.3: student, educator, professional)
// -----------------------------------------------------------------------------

export function buildLearningMaterialRequest(
  material: ArtifactEventMaterial,
  audience: "student" | "educator" | "professional",
): TextRequest {
  const system = [
    `You are an interactive curriculum and learning materials designer for Personal News (${material.industryName}).`,
    `Transform the verified news event into high-quality learning materials tailored for: ${audience.toUpperCase()}.`,
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "audience": "${audience}",
  "conceptExplainer": "A thorough, engaging 2-4 paragraph explanation of the core technical/conceptual foundations behind this story.",
  "glossary": [
    {
      "term": "Essential term",
      "definition": "Precise, accessible definition in context"
    }
  ],
  "quiz": [
    {
      "question": "Multiple-choice comprehension or critical thinking question testing key concepts from the story.",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answerIndex": 0,
      "explanation": "Clear explanation of why this answer is correct and why other options are incorrect or incomplete."
    }
  ],
  "discussionQuestions": [
    "Thought-provoking questions encouraging deeper inquiry, ethical evaluation, or debate."
  ],
  "activities": [
    "Practical, actionable learning or classroom activities (e.g. simulation, data exploration, debate, or case study exercise)."
  ]
}`,
    "Rules:",
    "- Provide at least 2 quiz questions with 3-4 options each.",
    "- Make the quiz answers unambiguous and directly grounded in the text.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: LEARNING_MATERIAL_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseLearningMaterialOutput(
  rawText: string,
): LearningMaterial | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = learningMaterialSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Policy Impact Explorer (Education: N§3)
// -----------------------------------------------------------------------------

export function buildPolicyImpactExplorerRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are an education policy intelligence specialist for Personal News (${material.industryName}).`,
    "Analyze the education policy development in this story using the Policy Impact Explorer framework.",
    `Produce a JSON object matching this schema:
{
  "policyName": "Official or descriptive name of the policy, regulation, or curriculum initiative.",
  "summary": "Factual overview of the policy mandate, its statutory or administrative context, and stated goals.",
  "affectedAudiences": [
    {
      "group": "e.g. K-12 Teachers, School Districts, Higher Ed Institutions, Students, or EdTech Vendors",
      "impact": "Specific direct or compliance consequence for this stakeholder group."
    }
  ],
  "timeline": [
    {
      "phase": "e.g. Immediate / Q1 2027 / Mandatory Compliance",
      "milestone": "What occurs or must be implemented by this point."
    }
  ],
  "remainingUncertainties": [
    "Unresolved legal, funding, technical, or implementation ambiguities."
  ]
}`,
    "Rules:",
    "- Ground all impacts strictly on the reported facts.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parsePolicyImpactExplorerOutput(
  rawText: string,
): PolicyImpactExplorer | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = policyImpactExplorerSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Classroom Discussion Builder (Education: N§3)
// -----------------------------------------------------------------------------

export function buildClassroomDiscussionBuilderRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a master educator and pedagogical designer for Personal News (${material.industryName}).`,
    "Turn the verified news story into an actionable classroom discussion and activity guide.",
    `Produce a JSON object matching this schema:
{
  "topic": "Core pedagogical theme or question raised by the story.",
  "gradeLevels": ["e.g. Middle School", "High School", "Undergraduate"],
  "discussionQuestions": [
    {
      "question": "Engaging discussion prompt for students.",
      "learningGoal": "What critical thinking skill or concept this question fosters."
    }
  ],
  "classroomActivities": [
    {
      "activity": "Name of the structured classroom activity (e.g. Socratic Seminar, Jigsaw, Policy Debate)",
      "instructions": "Clear step-by-step facilitation instructions for the teacher or instructor."
    }
  ]
}`,
    "Rules:",
    "- Ensure activities are evidence-based and suitable for academic settings.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseClassroomDiscussionBuilderOutput(
  rawText: string,
): ClassroomDiscussionBuilder | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = classroomDiscussionBuilderSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Education Evidence Checker (Education: N§3)
// -----------------------------------------------------------------------------

export function buildEducationEvidenceCheckerRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are an empirical education research evaluator for Personal News (${material.industryName}).`,
    "Critically assess promotional claims versus measured empirical learning outcomes in this story.",
    `Produce a JSON object matching this schema:
{
  "subject": "The educational tool, curriculum, intervention, or methodology being evaluated.",
  "claimedOutcomes": "What promoters, companies, or press releases claim the tool/intervention achieves.",
  "measuredOutcomes": "What the actual empirical data or peer-reviewed study measured (e.g. completion speed vs deep problem-solving transfer).",
  "studyDesign": {
    "samplePopulation": "Number of participants, grade level, and school setting (or 'Not specified').",
    "comparisonGroup": "Control group characteristics or 'No control group used'.",
    "metricUsed": "Specific assessment or test instrument used to evaluate outcomes."
  },
  "promotionalGap": "Explicit critique of the gap between promotional headlines and demonstrated learning gains.",
  "limitations": [
    "Methodological limitations, small sample sizes, lack of long-term retention data, or conflicts of interest."
  ]
}`,
    "Rules:",
    "- Distinguish completing exercises faster from demonstrating genuine concept transfer.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseEducationEvidenceCheckerOutput(
  rawText: string,
): EducationEvidenceChecker | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = educationEvidenceCheckerSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// AI-in-Finance Reality Check (Finance: N§3 & N§4)
// -----------------------------------------------------------------------------

export function buildFinanceRealityCheckRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a quantitative finance and AI risk auditor for Personal News (${material.industryName}).`,
    "Separate promotional AI announcements and backtests from documented live trading deployments and regulatory reality.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "claimant": "Financial institution, hedge fund, or fintech firm making the claim.",
  "claimSummary": "The claimed outperformance, efficiency gain, or trading advantage.",
  "claimType": "One of: announcement | pilot | backtest | live_deployment | regulatory_finding",
  "testPeriodAndBenchmark": "The time period analyzed, benchmark index used (e.g. 60/40, S&P 500), and test methodology.",
  "costsAndAssumptions": "Slippage, transaction costs, leverage, data snooping caveats, or market conditions assumed.",
  "disclosedCautions": [
    "Explicit caveats and disclaimers made by the researchers or authors themselves (e.g. in-sample overfitting warnings)."
  ]
}`,
    "Rules:",
    "- Emphasize that backtests and in-sample performance are not evidence of future outperformance.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseFinanceRealityCheckOutput(
  rawText: string,
): FinanceRealityCheck | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = financeRealityCheckSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Regulation Watch (Finance: N§3 & N§4)
// -----------------------------------------------------------------------------

export function buildRegulationWatchRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a financial regulatory compliance intelligence analyst for Personal News (${material.industryName}).`,
    "Analyze the regulatory enforcement action, rule proposal, or guidance in this story.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "regulator": "Regulatory agency (e.g. SEC, FINRA, Federal Reserve, CFPB, CFTC, ECB).",
  "actionTitle": "Official name or subject of the rule, circular, consent order, or enforcement action.",
  "summary": "Core factual summary of the regulatory action and rationale.",
  "affectedInstitutions": [
    "Specific market participants impacted (e.g. Broker-Dealers, Registered Investment Advisers, Bank Holding Companies)."
  ],
  "keyRequirements": [
    "Actionable compliance requirements, disclosure mandates, or governance rules."
  ],
  "effectiveDate": "Effective date, comment deadline, or implementation transition period.",
  "enforcementContext": "Statutory basis, penalties, or historical context surrounding this enforcement."
}`,
    "Rules:",
    "- Cite specific rules, statutes, or release numbers when present in the text.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseRegulationWatchOutput(
  rawText: string,
): RegulationWatch | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = regulationWatchSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Finance Concepts for Learners (Finance: N§3)
// -----------------------------------------------------------------------------

export function buildFinanceConceptExplainerRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a financial literacy and market concepts educator for Personal News (${material.industryName}).`,
    "Identify the foundational financial concept underlying this news development and explain it clearly for learners.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "conceptName": "The underlying financial instrument, mechanism, or economic principle (e.g. In-Sample Overfitting, Yield Curve Inversion, Liquidity Coverage Ratio).",
  "plainEnglishDefinition": "Clear, accessible explanation of how this concept works without unnecessary Wall Street jargon.",
  "applicationInStory": "How exactly this concept applies to the events and companies described in the story.",
  "commonPitfalls": [
    "Common misunderstandings or false assumptions beginners make regarding this concept."
  ],
  "keyTakeaways": [
    "Key principles for evaluating financial news involving this concept."
  ]
}`,
    "Rules:",
    "- Ensure absolute conceptual precision while remaining accessible.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseFinanceConceptExplainerOutput(
  rawText: string,
): FinanceConceptExplainer | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = financeConceptExplainerSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Skills and Career Trends (Industry: N§3)
// -----------------------------------------------------------------------------

export function buildSkillsCareerTrendsRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a workforce intelligence and industry transformation analyst for Personal News (${material.industryName}).`,
    "Analyze how the industrial, technological, and corporate shifts in this story impact skills and career paths.",
    `Produce a JSON object matching this schema:
{
  "industryShift": "The macroeconomic, supply chain, automation, or technology shift underway.",
  "emergingSkills": [
    "High-demand technical, operational, or analytical capabilities growing in importance."
  ],
  "decliningOrAtRiskSkills": [
    "Legacy competencies or routines being automated, displaced, or downsized."
  ],
  "affectedOccupations": [
    {
      "role": "Job title or profession (e.g. Process Engineer, Semiconductor Yield Analyst, Assembly Technician)",
      "impact": "How daily work, required toolchains, or employment demand is evolving."
    }
  ],
  "trainingRecommendations": [
    "Practical certifications, curriculum areas, or hands-on experiences workers and students should target."
  ]
}`,
    "Rules:",
    "- Base skills projections strictly on the verified industrial developments.",
    "- Output valid raw JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseSkillsCareerTrendsOutput(
  rawText: string,
): SkillsCareerTrends | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = skillsCareerTrendsSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Industry Impact Report (Newsren §2.4)
// -----------------------------------------------------------------------------

export function buildIndustryImpactReportRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a senior cross-industry intelligence analyst for Personal News (${material.industryName}).`,
    "Produce an Industry Impact Report evaluating how this story affects specific industries, occupations, and decision makers.",
    "CRITICAL EDITORIAL RULE: You must clearly distinguish between evidence-grounded facts and analytical speculation.",
    "- If an impact is supported by verified facts, statements, or benchmarks in the reports, mark basis as 'evidence_based' and cite a specific Claim ID (from Verified Claims) or an article ID and direct quote.",
    "- If an impact is a logical extrapolation or scenario projection, mark basis as 'speculative' and omit/clear citation.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "summary": "Executive summary of the cross-industry transmission mechanism and macro significance.",
  "affectedIndustries": [
    {
      "industry": "Specific industry sector (e.g. Semiconductor Foundry, Cloud Infrastructure, Automotive OEM).",
      "impact": "Concrete operational, technical, or commercial consequence.",
      "transmissionPath": "How the change propagates into this sector.",
      "basis": "evidence_based" or "speculative",
      "citation": {
        "claimId": 123 (optional: reference to Claim ID from verified claims),
        "articleId": 456 (optional: reference to Article ID),
        "sourceDomain": "domain.com" (optional),
        "quote": "Direct quote from source" (optional)
      }
    }
  ],
  "affectedOccupations": [
    {
      "role": "Specific job title or profession (e.g. Silicon Layout Engineer, Curriculum Coordinator).",
      "impact": "Day-to-day workflow change, tooling shift, or labor demand trend.",
      "timeframe": "immediate" or "short_term" or "long_term",
      "basis": "evidence_based" or "speculative",
      "citation": null (or citation object if evidence_based)
    }
  ],
  "decisionImplications": [
    {
      "decisionMaker": "Role or executive persona (e.g. Enterprise Procurement Officer, CTO, University Dean).",
      "recommendationOrTradeoff": "Key strategic recommendation, trade-off, or risk to evaluate.",
      "basis": "evidence_based" or "speculative",
      "citation": null (or citation object if evidence_based)
    }
  ]
}`,
    "Rules:",
    "- Never invent benchmark numbers, regulatory mandates, or vendor commitments. Speculative impacts must be labeled 'speculative'.",
    "- Output valid raw JSON only, without markdown code fences or commentary.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
    "\nVerified Claims and Quotes (for citation anchoring):",
    formatVerifiedClaimsContext(material.verifiedClaims),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseIndustryImpactReportOutput(
  rawText: string,
  material?: ArtifactEventMaterial,
): IndustryImpactReport | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = industryImpactReportSchema.safeParse(parsed);
    if (!res.success) {
      return null;
    }
    const data = res.data;

    // Semantic citation verification: if material is provided, verify evidence citations
    if (material) {
      const claimLookup = new Map(
        (material.verifiedClaims || []).map((c) => [c.id, c]),
      );
      const articleLookup = new Map(material.articles.map((a) => [a.id, a]));

      const verifyAndDowngrade = <
        T extends {
          basis: "evidence_based" | "speculative";
          citation?: {
            claimId?: number;
            articleId?: number;
            sourceDomain?: string;
            quote?: string;
          } | null;
        },
      >(
        item: T,
      ): T => {
        if (item.basis === "evidence_based") {
          let verified = false;
          const sanitizedCitation = item.citation ? { ...item.citation } : null;

          if (sanitizedCitation?.claimId !== undefined) {
            const matchedClaim = claimLookup.get(sanitizedCitation.claimId);
            // Must exist and must have consensusStatus 'verified'
            // Disputed or unverified claims cannot support evidence_based
            if (matchedClaim && matchedClaim.consensusStatus === "verified") {
              verified = true;
              // If model additionally provided an attached quote, verify that it's in actual bodyText
              let quoteVerified = false;
              if (sanitizedCitation.quote) {
                const trimmedQuote = sanitizedCitation.quote.trim();
                if (trimmedQuote.length >= 5) {
                  const targetArticles = sanitizedCitation.articleId
                    ? [articleLookup.get(sanitizedCitation.articleId)].filter(
                        Boolean,
                      )
                    : material.articles;
                  for (const art of targetArticles) {
                    if (
                      art?.bodyText &&
                      art.bodyText
                        .toLowerCase()
                        .includes(trimmedQuote.toLowerCase())
                    ) {
                      quoteVerified = true;
                      sanitizedCitation.articleId = art.id;
                      sanitizedCitation.sourceDomain = art.sourceDomain;
                      break;
                    }
                  }
                }
              }
              if (!quoteVerified) {
                // Do not display hallucinated quote, articleId, or sourceDomain alongside verified claim ID
                delete sanitizedCitation.quote;
                delete sanitizedCitation.articleId;
                delete sanitizedCitation.sourceDomain;
              }
            } else {
              // Invalid or disputed claimId: clear it so quote fallback does not carry a ghost claimId
              delete sanitizedCitation.claimId;
            }
          }

          // If not verified via claim, verify via direct raw bodyText quote
          if (
            !verified &&
            sanitizedCitation?.quote &&
            sanitizedCitation.quote.trim().length >= 5
          ) {
            const trimmedQuote = sanitizedCitation.quote.trim();
            const targetArticles = sanitizedCitation.articleId
              ? [articleLookup.get(sanitizedCitation.articleId)].filter(Boolean)
              : material.articles;
            for (const art of targetArticles) {
              // Quote MUST come from actual raw bodyText, not AI summary or title
              if (
                art?.bodyText &&
                art.bodyText.toLowerCase().includes(trimmedQuote.toLowerCase())
              ) {
                verified = true;
                delete sanitizedCitation.claimId;
                sanitizedCitation.articleId = art.id;
                sanitizedCitation.sourceDomain = art.sourceDomain;
                break;
              }
            }
          }

          if (!verified) {
            // Phantom, disputed, or unverified citation: safely downgrade to speculative
            return {
              ...item,
              basis: "speculative",
              citation: null,
            };
          }

          return {
            ...item,
            citation: sanitizedCitation,
          };
        }
        return item;
      };

      data.affectedIndustries = data.affectedIndustries.map(verifyAndDowngrade);
      data.affectedOccupations =
        data.affectedOccupations.map(verifyAndDowngrade);
      data.decisionImplications =
        data.decisionImplications.map(verifyAndDowngrade);
    }

    return data;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Supply-Chain Ripple Map (Newsren §3 Industry)
// -----------------------------------------------------------------------------

export function buildSupplyChainRippleMapRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are an industrial supply chain modeling specialist for Personal News (${material.industryName}).`,
    "Generate a Supply-Chain Ripple Map modeling potential upstream component/equipment and downstream assembly/distribution ramifications.",
    "CRITICAL EDITORIAL RULE: In accordance with Newsren §3, supply chain ripple consequences MUST be presented strictly as hypotheses, NOT established certainties.",
    "Every item in upstreamRipples and downstreamRipples MUST set isHypothesis: true.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "focalNode": "The central industrial/corporate shift or transition being analyzed (e.g. Foundry 3nm node ramp-up).",
  "upstreamRipples": [
    {
      "target": "Upstream tier-1 / tier-2 supplier sector or input commodity (e.g. Photolithography Optics, Wafer Substrates).",
      "effect": "Hypothesized volume, pricing, or supply lead time implication.",
      "transmissionChannel": "How demand or supply shock transmits upstream.",
      "isHypothesis": true,
      "confidence": "high" or "medium" or "low"
    }
  ],
  "downstreamRipples": [
    {
      "target": "Downstream OEM, integrator, or end-market (e.g. Hyperscale Datacenters, Smartphone Assembly).",
      "effect": "Hypothesized margin, product cadence, or substitution pressure.",
      "transmissionChannel": "How output shock or cost propagates downstream.",
      "isHypothesis": true,
      "confidence": "high" or "medium" or "low"
    }
  ],
  "keyHypotheses": [
    "Core working hypothesis about inventory buffers or substitution elasticities."
  ]
}`,
    "Rules:",
    "- All ripple impacts MUST be presented as hypotheses (isHypothesis must be true).",
    "- Output valid raw JSON only, without markdown code fences or conversational filler.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nVerified Source Reports:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseSupplyChainRippleMapOutput(
  rawText: string,
): SupplyChainRippleMap | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);
    const res = supplyChainRippleMapSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Earnings Decoder (Newsren §4 Finance, §103, §139)
// -----------------------------------------------------------------------------

export function buildEarningsDecoderRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const filing = material.filing;
  const company = filing
    ? `${filing.companyName} (${filing.companyTicker}, CIK: ${filing.companyCik})`
    : material.eventTitle;

  const metricsTable = (material.calculatedMetrics ?? [])
    .map((m) => {
      const parts = [
        `- ${m.metricName} (${m.concept}): Reported=${m.reportedValue} ${m.unit}`,
      ];
      if (m.priorPeriodValue) {
        parts.push(
          `PriorQuarter=${m.priorPeriodValue} (${m.deltaQoQPercent ?? "N/A"})`,
        );
      }
      if (m.priorYearValue) {
        parts.push(
          `PriorYear=${m.priorYearValue} (${m.deltaYoYPercent ?? "N/A"})`,
        );
      }
      if (m.guidanceComparison && m.guidanceComparison !== "not_provided") {
        parts.push(`GuidanceComparison=${m.guidanceComparison}`);
      }
      return parts.join(" | ");
    })
    .join("\n");

  const system = [
    `You are an expert financial journalist and SEC filing analyst for Personal News (${material.industryName}).`,
    `Your task is to write a comprehensive, evidence-grounded Earnings Decoder briefing for ${company}.`,
    "FINANCE SECTION GUARDRAILS (Newsren §4, MANDATORY):",
    "1. Education and factual reporting only: NO buy/sell/hold ratings, NO price targets, NO trade execution advice, and NO predictive stock assertions.",
    "2. Every financial figure discussed in your analysis MUST be directly traceable to the verified XBRL facts and filing context provided.",
    "3. Never invent, extrapolate, or hallucinate non-reported financial figures.",
    "4. Highlight management operating context, revenue drivers, margin trends, and forward commentary.",
    `Produce a JSON object matching this schema:
{
  "executiveSummary": "2-4 paragraphs summarizing overall performance, reported figures versus prior periods and guidance, and strategic significance.",
  "keyDrivers": [
    "Key driver 1 detailing segment performance or major business trend.",
    "Key driver 2 detailing cost, margin, or operational dynamic."
  ],
  "forwardGuidance": [
    "Optional bullet summarizing management forward outlook or stated expectations if present."
  ]
}`,
    "- Output valid raw JSON only, without markdown code fences or conversational filler.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Company: ${company}`,
    filing
      ? `Filing: Form ${filing.form} (Accession: ${filing.accessionNumber}, Filed: ${filing.filingDate})`
      : "",
    "\nPre-computed Verified Financial Facts & Period Comparisons:",
    metricsTable || "No pre-computed metrics provided.",
    "\nFiling Document Context & Source Text:",
    formatArticlesContext(material.articles),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: VERTICAL_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseEarningsDecoderOutput(
  rawText: string,
  material?: ArtifactEventMaterial,
): EarningsDecoder | null {
  try {
    const jsonStr = extractJsonText(rawText);
    const parsed = JSON.parse(jsonStr);

    const filing = material?.filing;
    const companyInfo = {
      ticker: filing?.companyTicker || "N/A",
      name: filing?.companyName || material?.eventTitle || "Company",
      cik: filing?.companyCik || "0000000000",
    };

    let fy = filing?.fiscalYear;
    if (!fy && material?.financialFacts?.[0]?.fiscalYear) {
      fy = material.financialFacts[0].fiscalYear;
    }
    if (!fy && filing?.reportDate) {
      const parsed = parseInt(filing.reportDate.slice(0, 4), 10);
      if (!isNaN(parsed) && parsed > 1990 && parsed < 2100) fy = parsed;
    }
    if (!fy && filing?.filingDate) {
      const parsed = parseInt(filing.filingDate.slice(0, 4), 10);
      if (!isNaN(parsed) && parsed > 1990 && parsed < 2100) fy = parsed;
    }

    const filingInfo = {
      form: filing?.form || "10-Q",
      fiscalYear: fy,
      fiscalPeriod:
        filing?.fiscalPeriod ||
        material?.financialFacts?.[0]?.fiscalPeriod ||
        "N/A",
      filingDate: filing?.filingDate || "N/A",
      secUrl: filing?.secUrl || "https://www.sec.gov/edgar",
      accessionNumber: filing?.accessionNumber || "0000000000-00-000000",
    };

    // In pipeline execution (when material is provided), strictly require deterministic pre-computed metrics
    let metrics: EarningsMetric[] = [];
    if (material) {
      if (
        !material.calculatedMetrics ||
        material.calculatedMetrics.length === 0
      ) {
        return null;
      }
      metrics = material.calculatedMetrics;
    } else if (Array.isArray(parsed.metrics) && parsed.metrics.length > 0) {
      metrics = parsed.metrics;
    }

    if (metrics.length === 0) {
      return null;
    }

    const payload = {
      company: material ? companyInfo : parsed.company || companyInfo,
      filing: material ? filingInfo : parsed.filing || filingInfo,
      metrics,
      executiveSummary: parsed.executiveSummary,
      keyDrivers: parsed.keyDrivers,
      forwardGuidance: parsed.forwardGuidance,
      disclaimer:
        "本简报仅供资讯与学习参考，基于公开 SEC 申报文件生成，不构成任何投资建议、买卖要约或金融决策依据。",
    };

    const res = earningsDecoderSchema.safeParse(payload);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Technology products: Launch Reality Check, Technology Evolution Timeline (N§3)
// -----------------------------------------------------------------------------

/**
 * The quote as stored: every sentence of the cited article's source body
 * that the model's quote touches. Null when the model's quote is not copied
 * from that article of this material.
 */
function groundedQuote(
  material: ArtifactEventMaterial,
  q: SourceQuote,
): SourceQuote | null {
  // The schema's 20-character minimum applies to the text, not to padding.
  if (normalizeSourceText(q.quote).length < 20) return null;
  const article = material.articles.find((a) => a.id === q.articleId);
  const quote = groundedSentences(article?.sourceBodyText, q.quote);
  return quote === null ? null : { articleId: q.articleId, quote };
}

/**
 * The domain key of an article, from the host of its canonical URL, not
 * from the source's site domain. The URL parser
 * drops a port, lowercases, turns an IDN into punycode and writes IP
 * addresses in one form ("0x7f.1" -> "127.0.0.1", "[0:0::1]" -> "[::1]").
 * Trailing dots are removed. An IP literal is its own key; for a name, a
 * leading "www." is removed and the last two labels kept
 * ("blog.vendor.com" -> "vendor.com").
 * There is no public-suffix list, so multi-part suffixes collapse:
 * "x.co.uk" and "y.co.uk" both give "co.uk". That errs toward dropping
 * evidence, which is the safe direction. "" when the article is missing or
 * its URL does not parse or has no host name ("mailto:x@y.com").
 */
function articleDomain(
  material: ArtifactEventMaterial,
  articleId: number,
): string {
  const raw =
    material.articles.find((a) => a.id === articleId)?.canonicalUrl ?? "";
  let host: string;
  try {
    host = new URL(raw).hostname.replace(/\.+$/, "");
  } catch {
    return "";
  }
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  if (host.startsWith("www.")) host = host.slice(4);
  return host.split(".").slice(-2).join(".");
}

function groundedName(material: ArtifactEventMaterial, value: string): string {
  if (value === NOT_STATED_IN_SOURCES) return value;
  return material.articles.some((a) =>
    sourceTextContains(a.sourceBodyText, value),
  )
    ? value
    : NOT_STATED_IN_SOURCES;
}

export function buildLaunchRealityCheckRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a technology fact-checking editor for Daily (${material.industryName}).`,
    "Compare what a company claims about its AI model or product with independent evaluations reported in the source articles below.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "subject": "The model or product name, as written in the articles. If the articles do not name it, write "Not stated in sources".",
  "claimant": "The company or organization that makes the claims, as written in the articles. If not named, write "Not stated in sources".",
  "claims": [
    {
      "claim": "One capability claim by the claimant, in one plain sentence.",
      "claimQuote": { "articleId": 123, "quote": "Exact words copied from that article that state the claim." },
      "verdict": "independent_support" or "independent_dispute" or "no_independent_evidence",
      "independentEvidence": [
        { "articleId": 456, "quote": "Exact words copied from that article that report an independent benchmark, test or evaluation of this claim." }
      ]
    }
  ]
}`,
    "Rules:",
    "- Use only the articles below. Do not add benchmarks, numbers or names that are not in them.",
    "- Give 1 to 5 claims and at most 2 evidence quotes per claim. Each quote is 20 to 300 characters, copied character for character from the article with that ID.",
    "- Independent evidence comes from a party other than the claimant, such as a third-party benchmark, an outside test, a regulator or an unaffiliated researcher.",
    '- If the articles report no independent evaluation of a claim, use "no_independent_evidence" and an empty independentEvidence array. Do not guess.',
    "- Output valid raw JSON only, without markdown code fences or commentary.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nSource Articles:",
    formatArticlesContext(material.articles),
    "\nVerified Claims (context only; quote the articles, not this list):",
    formatVerifiedClaimsContext(material.verifiedClaims),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: TECH_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

/**
 * Keeps only claims and evidence whose quotes are copied from an article of
 * `material`; makes the verdict agree with the evidence that is left.
 * Without `material` nothing can be checked, so the result is null.
 */
export function parseLaunchRealityCheckOutput(
  rawText: string,
  material?: ArtifactEventMaterial,
): LaunchRealityCheck | null {
  if (!material) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch {
    return null;
  }
  const raw = launchRealityCheckSchema.safeParse(parsed);
  if (!raw.success) return null;

  const claims = raw.data.claims.flatMap((c) => {
    const claimQuote = groundedQuote(material, c.claimQuote);
    if (!claimQuote) return [];
    const claimText = normalizeSourceText(c.claimQuote.quote);
    const claimDomain = articleDomain(material, c.claimQuote.articleId);
    // Evidence is independent only when it comes from another article on
    // another domain: the claimant's own pages cannot confirm the claim.
    // An empty domain key on either side cannot be compared, so it drops.
    const evidence =
      c.verdict === "no_independent_evidence"
        ? []
        : c.independentEvidence.flatMap((e) => {
            const evidenceDomain = articleDomain(material, e.articleId);
            const quote = groundedQuote(material, e);
            return quote &&
              e.articleId !== c.claimQuote.articleId &&
              claimDomain !== "" &&
              evidenceDomain !== "" &&
              evidenceDomain !== claimDomain &&
              normalizeSourceText(e.quote) !== claimText
              ? [quote]
              : [];
          });
    const verdict =
      evidence.length === 0 ? ("no_independent_evidence" as const) : c.verdict;
    return [{ ...c, claimQuote, verdict, independentEvidence: evidence }];
  });

  const out = launchRealityCheckSchema.safeParse({
    subject: groundedName(material, raw.data.subject),
    claimant: groundedName(material, raw.data.claimant),
    claims,
  });
  return out.success ? out.data : null;
}

export function buildEvolutionTimelineRequest(
  material: ArtifactEventMaterial,
): TextRequest {
  const system = [
    `You are a technology history editor for Daily (${material.industryName}).`,
    "Build a Technology Evolution Timeline for this story: the releases, evaluations, corrections and adoption milestones that the source articles below report.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    `Produce a JSON object matching this schema:
{
  "entries": [
    {
      "date": "The date as the article states it, for example "March 2026" or "2026-03-14". If the article gives no date, write "Not stated in sources".",
      "dateSource": "stated_in_text" or "report_published",
      "kind": "release" or "evaluation" or "correction" or "adoption",
      "description": "What happened, in one plain sentence.",
      "source": { "articleId": 123, "quote": "Exact words copied from that article that report this milestone." }
    }
  ]
}`,
    "Rules:",
    "- Use only the articles below. Do not add events, dates or names that are not in them.",
    '- Give 2 to 8 entries, earliest first. Entries dated "Not stated in sources" go last.',
    '- Use "report_published" when the milestone is the news that the article itself reports and the text gives no date. The date is then the publication date listed for that article.',
    "- Each quote is 20 to 300 characters, copied character for character from the article with that ID.",
    "- Output valid raw JSON only, without markdown code fences or commentary.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    `Event: ${material.eventTitle}`,
    "\nPublication dates (UTC):",
    material.articles
      .map(
        (a) =>
          `- Article ID ${a.id}: ${a.publishedAt === null ? "not stated" : localDate(a.publishedAt, "UTC")}`,
      )
      .join("\n"),
    "\nSource Articles:",
    formatArticlesContext(material.articles),
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: TECH_PRODUCT_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

/**
 * Keeps only entries whose quotes are copied from an article of `material`,
 * each quote stored as its whole sentences. The model's date fields are kept
 * as written and never shown: the card shows and sorts by the cited
 * article's publish date.
 */
export function parseEvolutionTimelineOutput(
  rawText: string,
  material?: ArtifactEventMaterial,
): TechnologyEvolutionTimeline | null {
  if (!material) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch {
    return null;
  }
  const raw = technologyEvolutionTimelineSchema.safeParse(parsed);
  if (!raw.success) return null;

  const entries = raw.data.entries.flatMap((e) => {
    const source = groundedQuote(material, e.source);
    return source ? [{ ...e, source }] : [];
  });

  const out = technologyEvolutionTimelineSchema.safeParse({ entries });
  return out.success ? out.data : null;
}
