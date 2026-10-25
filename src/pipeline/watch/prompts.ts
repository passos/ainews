import type { TextRequest } from "../../providers/adapters";
import { WRITE_MAX_OUTPUT_TOKENS, WRITE_THINKING } from "../analyze/prompts";

export const WATCH_PROMPT_VERSION = "watch-v1";

export function buildWatchJudgeQuestion(question: string, criteria: string) {
  return {
    progress: {
      type: "noul" as const,
      instructions: [
        "Assess whether the new reporting in this news event constitutes a material development answering the reader's topic question according to the criteria.",
        "A repeated report, superficial commentary, or minor non-substantive mention does NOT qualify.",
        `Topic Question: "${question}"`,
        `Criteria for Material Development: "${criteria}"`,
      ].join("\n"),
      criteria: {
        true: "The update reports new, substantive facts, benchmarks, releases, or actions satisfying the criteria.",
        false:
          "The update only repeats existing claims, offers commentary, or lacks material progress according to the criteria.",
      },
    },
  };
}

export function buildWatchSummaryPrompt(
  question: string,
  criteria: string,
  eventTitle: string,
  newArticles: { title: string; summary: string | null }[],
): TextRequest {
  const articlesText = newArticles
    .map(
      (a, i) =>
        `[Article ${i + 1}] ${a.title}\n${a.summary ? `Summary: ${a.summary}` : ""}`,
    )
    .join("\n\n");

  const prompt = [
    "You explain 'What is new here' (in 1-2 concise, factual sentences, maximum 280 characters) for a tracked news topic.",
    `Topic Question: "${question}"`,
    `Criteria: "${criteria}"`,
    `Event Title: "${eventTitle}"`,
    "New Reporting in this update:",
    articlesText,
    "",
    "Rules:",
    "- State directly what specific new event, release, evaluation, or fact occurred.",
    "- Do not use fluff words (e.g. 'In an exciting turn of events').",
    "- Output ONLY the 1-2 sentence explanation as plain text.",
  ].join("\n");

  return {
    system:
      "You explain what is new in a tracked news topic in 1-2 concise, factual sentences.",
    prompt,
    maxOutputTokens: WRITE_MAX_OUTPUT_TOKENS,
    thinkingConfig: WRITE_THINKING,
  };
}
