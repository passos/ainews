import { z } from "zod";
import type { TextRequest } from "../../providers/adapters";
import { CLAIM_TYPES, EVIDENCE_STANCES } from "../../lib/evidence/types";

export const CLAIMS_PROMPT_VERSION = "claims:v1";

const WRITE_THINKING = { thinkingLevel: "low" as const };

export interface ArticleEvidenceInput {
  id: number;
  title: string;
  sourceName: string;
  sourceDomain: string;
  bodySha: string;
  isPrimarySource: boolean;
  bodyText: string;
}

export interface EventEvidenceInput {
  eventId: number;
  eventTitle: string;
  industryName: string;
  disclaimer: string | null;
  articles: ArticleEvidenceInput[];
}

export const rawCitationSchema = z.strictObject({
  articleId: z.number().int().positive(),
  quote: z.string().min(15),
  stance: z.enum(EVIDENCE_STANCES),
});

export type RawCitation = z.infer<typeof rawCitationSchema>;

export const rawClaimSchema = z.strictObject({
  claimText: z.string().min(5),
  claimType: z.enum(CLAIM_TYPES),
  citations: z.array(rawCitationSchema).min(1),
});

export type RawClaim = z.infer<typeof rawClaimSchema>;

export const rawClaimsOutputSchema = z.strictObject({
  claims: z.array(rawClaimSchema),
});

export type RawClaimsOutput = z.infer<typeof rawClaimsOutputSchema>;

export function buildClaimsExtractionRequest(
  material: EventEvidenceInput,
): TextRequest {
  const system = [
    `You are the Evidence and Bias Inspection agent for Personal News (${material.industryName}).`,
    "Your mission: extract the core claims made across verified reports on a unified developing event, and trace each claim directly to verbatim source quotes.",
    "Guidelines:",
    "1. Extract 2 to 6 primary claims.",
    "2. Categorize each claim into one of:",
    "   - 'fact': empirically verifiable occurrence, measurement, or stated event.",
    "   - 'interpretation': analysis, commentary, assessment, or synthesis.",
    "   - 'prediction': forecast, projection, future scenario, or expected outcome.",
    "3. For each claim, cite verbatim quotes from the provided articles:",
    "   - 'quote': MUST be an exact, word-for-word excerpt from the article body (minimum 15 characters). DO NOT paraphrase or modify quotes.",
    "   - 'stance': 'support' if the article affirms or provides evidence for the claim; 'dispute' if the article contradicts, questions, or denies the claim.",
    material.disclaimer ? `Editorial constraint: ${material.disclaimer}` : "",
    "Output MUST be valid JSON adhering strictly to this schema:",
    `{
  "claims": [
    {
      "claimText": "Concise statement of the claim",
      "claimType": "fact" | "interpretation" | "prediction",
      "citations": [
        {
          "articleId": 123,
          "quote": "Exact verbatim sentence or clause from article 123",
          "stance": "support" | "dispute"
        }
      ]
    }
  ]
}`,
    "Respond ONLY with the JSON object. Do not enclose in markdown backticks if possible, or use standard ```json.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const promptArticles = material.articles.map((a) => {
    return [
      `--- Article ID: ${a.id} ---`,
      `Source: ${a.sourceName} (${a.sourceDomain})${a.isPrimarySource ? " [PRIMARY SOURCE]" : ""}`,
      `Title: ${a.title}`,
      "Body:",
      a.bodyText.slice(0, 4000), // Adequate window for claim extraction
    ].join("\n");
  });

  const prompt = [
    `Event: ${material.eventTitle}`,
    "Reports to inspect:",
    "",
    ...promptArticles,
    "",
    "Extract the key claims and verbatim citations in JSON format:",
  ].join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: 2500,
    thinkingConfig: WRITE_THINKING,
  };
}

export function parseClaimsOutput(rawText: string): RawClaimsOutput | null {
  if (!rawText || rawText.trim().length === 0) {
    return null;
  }

  let text = rawText.trim();
  // Strip Markdown code fences if present
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  try {
    const parsed = JSON.parse(text);
    const res = rawClaimsOutputSchema.safeParse(parsed);
    if (!res.success) {
      return null;
    }
    return res.data;
  } catch {
    return null;
  }
}
