import {
  type AudienceExplain,
  type ResearchPaperDecoder,
  type StoryBrief,
  audienceExplainSchema,
  researchPaperDecoderSchema,
  storyBriefSchema,
} from "../../lib/artifacts/types";
import type { TextRequest } from "../../providers/adapters";
import { WRITE_THINKING } from "../analyze/prompts";

export const STORY_BRIEF_PROMPT_VERSION = "brief-v1";
export const AUDIENCE_EXPLAIN_PROMPT_VERSION = "explain-v1";
export const RESEARCH_PAPER_DECODER_PROMPT_VERSION = "decoder-v1";

export const BRIEF_MAX_OUTPUT_TOKENS = 1500;
export const EXPLAIN_MAX_OUTPUT_TOKENS = 2000;
export const DECODER_MAX_OUTPUT_TOKENS = 2500;

export interface ArtifactArticleMaterial {
  id: number;
  title: string;
  sourceName: string;
  sourceDomain: string;
  publishedAt: number | null;
  summary: string | null;
  bodyText?: string | null;
}

export interface ArtifactEventMaterial {
  eventId: number;
  eventTitle: string;
  industryName: string;
  industrySlug: string;
  disclaimer?: string | null;
  articles: ArtifactArticleMaterial[];
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

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
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
