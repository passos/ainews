import { z } from "zod";
import type { TextRequest } from "../../providers/adapters";

export const ASK_PROMPT_VERSION = "ask:v1";

export const ASK_THINKING = { thinkingLevel: "low" as const };

export const ASK_MAX_OUTPUT_TOKENS = 3000;

export const MAX_BODY_CHARS_PER_ARTICLE = 40000;

export interface ArticleAskContext {
  id: number;
  title: string;
  sourceName: string;
  sourceDomain: string;
  isPrimarySource: boolean;
  bodySha: string;
  bodyText: string;
}

export interface AskPromptInput {
  question: string;
  scopeDescription?: string;
  articles: ArticleAskContext[];
}

export const rawAskCitationSchema = z.strictObject({
  articleId: z.number().int().positive(),
  quote: z.string().min(15),
  claim: z.string(),
});

export type RawAskCitation = z.infer<typeof rawAskCitationSchema>;

export const rawAskOutputSchema = z.strictObject({
  sufficient: z.boolean(),
  neededUrls: z.array(z.string()).default([]),
  answer: z.string(),
  unverified: z.array(z.string()).default([]),
  citations: z.array(rawAskCitationSchema).default([]),
});

export type RawAskOutput = z.infer<typeof rawAskOutputSchema>;

export function buildAskRequest(input: AskPromptInput): TextRequest {
  const system = [
    "You are Newsren Ask, a strict evidence-grounded AI research assistant for news intelligence.",
    "Your mission: answer the user's question using ONLY the provided verified article excerpts and facts.",
    "Core Guidelines:",
    "1. Grounding: Every factual statement in 'answer' must be backed by an exact verbatim quote from the provided texts, referenced in 'citations'.",
    "2. Quotations: In 'citations', each 'quote' MUST be an exact, word-for-word excerpt from the corresponding article body (minimum 15 characters). Never truncate negations, never alter numbers, never paraphrase or hallucinate quotes.",
    "3. Honesty & Refusal: If the provided excerpts do not contain sufficient evidence to answer the question or parts of the question:",
    "   - Set 'sufficient: false'.",
    "   - In 'unverified', list clearly what specific claims, facts, or questions could NOT be verified from the available text.",
    "   - If no reliable evidence exists, explain in 'answer' that the system could not find evidence and refuse to speculate or invent details.",
    "   - If the question mentions specific external URLs from trusted sources that were not provided in the text context, you may list them in 'neededUrls'. Otherwise leave 'neededUrls' empty.",
    "4. Anti-Hallucination: NEVER fabricate answers from pre-trained memory if the text does not state it.",
    "Output MUST be valid JSON adhering strictly to this schema:",
    `{
  "sufficient": true | false,
  "neededUrls": ["https://..."],
  "answer": "Detailed, clear synthesized answer with grounded reasoning.",
  "unverified": ["Aspects of the question or claims that could not be verified"],
  "citations": [
    {
      "articleId": 123,
      "quote": "Exact verbatim passage from article 123",
      "claim": "The claim supported or referenced by this quote"
    }
  ]
}`,
    "Respond ONLY with the JSON object. Do not enclose in markdown backticks if possible, or use standard ```json.",
  ].join("\n\n");

  const promptArticles = input.articles.map((a) => {
    return [
      `--- Article ID: ${a.id} ---`,
      `Source: ${a.sourceName} (${a.sourceDomain})${a.isPrimarySource ? " [PRIMARY SOURCE]" : ""}`,
      `Title: ${a.title}`,
      "Body:",
      a.bodyText.length > MAX_BODY_CHARS_PER_ARTICLE
        ? a.bodyText.slice(0, MAX_BODY_CHARS_PER_ARTICLE) +
          "\n...[text truncated]..."
        : a.bodyText,
    ].join("\n");
  });

  const prompt = [
    input.scopeDescription ? `Scope: ${input.scopeDescription}` : "",
    `Question: ${input.question}`,
    "",
    "Available verified reports:",
    "",
    ...promptArticles,
    "",
    "Answer the question in JSON format:",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    system,
    prompt,
    maxOutputTokens: ASK_MAX_OUTPUT_TOKENS,
    thinkingConfig: ASK_THINKING,
  };
}

export function parseAskOutput(rawText: string): RawAskOutput | null {
  if (!rawText || rawText.trim().length === 0) {
    return null;
  }

  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  try {
    const parsed = JSON.parse(text);
    const res = rawAskOutputSchema.safeParse(parsed);
    if (!res.success) {
      return null;
    }
    return res.data;
  } catch {
    return null;
  }
}
