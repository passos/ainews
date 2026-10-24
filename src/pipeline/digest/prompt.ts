import type { TextRequest } from "../../providers/adapters";
import { WRITE_THINKING } from "../analyze/prompts";

export const DIGEST_PROMPT_VERSION = "digest-daily-v1";
export const DIGEST_MAX_OUTPUT_TOKENS = 2000;

export interface DigestPromptEvent {
  id: number;
  title: string;
  summary: string;
  sourceName: string;
  score: number;
  articleCount: number;
}

export interface DigestPromptInput {
  industryName: string;
  disclaimer?: string | null;
  periodStart: string; // YYYY-MM-DD
  events: DigestPromptEvent[];
}

export function buildDigestRequest(input: DigestPromptInput): TextRequest {
  const parts: string[] = [
    `You are an executive editor for Personal News (${input.industryName}).`,
    `Synthesize a concise daily intelligence briefing for ${input.periodStart}.`,
    input.disclaimer ? `Editorial constraint: ${input.disclaimer}` : "",
    `Required output format:
Respond ONLY with a valid JSON object matching this schema:
{
  "intro": "A 50-100 word synthesis explaining today's overarching themes or significant shifts. Do not merely list stories. Maintain an objective, disciplined editorial tone.",
  "items": [
    {
      "event_id": <number>,
      "one_liner": "A single sentence (under 25 words) explaining why this development matters (the 'So what?')."
    }
  ]
}`,
    "Rules:",
    "- Provide an entry in 'items' for each candidate event.",
    "- Output raw JSON only. Do not add markdown code fences, notes, or explanations.",
  ];

  return {
    system: parts.filter(Boolean).join("\n\n"),
    prompt: `Candidate events for ${input.periodStart} (JSON):\n${JSON.stringify(input.events)}`,
    maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}

export interface ParsedDigestOutput {
  intro: string;
  items: Array<{
    event_id: number;
    one_liner: string;
  }>;
}

export function parseDigestOutput(rawText: string): ParsedDigestOutput | null {
  try {
    let clean = rawText.trim();
    // Strip markdown code fences if present
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed !== "object") return null;

    const intro = typeof parsed.intro === "string" ? parsed.intro.trim() : "";
    const items: Array<{ event_id: number; one_liner: string }> = [];

    if (Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        if (
          item &&
          typeof item === "object" &&
          typeof item.event_id === "number" &&
          typeof item.one_liner === "string"
        ) {
          items.push({
            event_id: item.event_id,
            one_liner: item.one_liner.trim(),
          });
        }
      }
    }

    return { intro, items };
  } catch {
    return null;
  }
}
