import { describe, expect, it } from "vitest";
import {
  JEV_MAX_INPUT_TOKENS,
  JevInputTooLargeError,
  buildJevInput,
  estimateTokens,
  parseJevOutput,
} from "../../src/providers/jev";
import { ResponseParseError } from "../../src/providers/adapters";
import { jevResponse } from "./fixtures";

/** String.prototype.isWellFormed (ES2024; tsconfig lib is ES2022). */
function isWellFormed(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

const QUESTIONS = {
  relevant: { type: "noul", instructions: "Is it relevant?" },
} as const;

describe("jev", () => {
  it("leaves a small input unchanged", () => {
    const state = { title: "T", summary: "S", body: "B" };
    expect(buildJevInput(state, QUESTIONS)).toEqual({
      state,
      questions: QUESTIONS,
    });
  });

  it("truncates an oversized body to fit and keeps the title", () => {
    const title = "A title ".repeat(20);
    const state = {
      title,
      summary: "short summary",
      // Quotes and newlines are escaped in JSON, so the estimate grows faster.
      body: 'line "quoted"\n'.repeat(20_000),
    };
    expect(estimateTokens({ state, questions: QUESTIONS })).toBeGreaterThan(
      JEV_MAX_INPUT_TOKENS,
    );

    const input = buildJevInput(state, QUESTIONS);
    expect(estimateTokens(input)).toBeLessThanOrEqual(JEV_MAX_INPUT_TOKENS);
    expect(input.state.title).toBe(title);
    expect(input.state.summary).toBe("short summary");
    expect(state.body.startsWith(input.state.body ?? "x")).toBe(true);
    expect((input.state.body ?? "").length).toBeGreaterThan(0);
  });

  it("cuts the summary after the body is empty", () => {
    const state = {
      title: "T",
      summary: "s".repeat(200_000),
      body: "b".repeat(200_000),
    };
    const input = buildJevInput(state, QUESTIONS);
    expect(estimateTokens(input)).toBeLessThanOrEqual(JEV_MAX_INPUT_TOKENS);
    expect(input.state.body).toBe("");
    expect(input.state.title).toBe("T");
    expect((input.state.summary ?? "").length).toBeGreaterThan(0);
  });

  it("throws when the input is still too large after cutting body and summary", () => {
    const state = { title: "T".repeat(100_000), summary: "s", body: "b" };
    expect(() => buildJevInput(state, QUESTIONS)).toThrow(
      JevInputTooLargeError,
    );
    expect(() => buildJevInput(state, QUESTIONS)).toThrow(RangeError);
  });

  // Each emoji is a surrogate pair. With these odd prefixes the unguarded
  // cut lands between the two halves of a pair (checked on the old code).
  it.each(["a", "aaaaaaa"])(
    "does not split a surrogate pair when cutting an emoji body (prefix %j)",
    (prefix) => {
      const state = { title: "T", body: prefix + "\u{1F600}".repeat(100_000) };
      const input = buildJevInput(state, QUESTIONS);
      expect(estimateTokens(input)).toBeLessThanOrEqual(JEV_MAX_INPUT_TOKENS);
      expect((input.state.body ?? "").length).toBeGreaterThan(0);
      expect(isWellFormed(input.state.body ?? "")).toBe(true);
    },
  );

  const ANSWER_QUESTIONS = {
    aboutWeather: { type: "noul", instructions: "i" },
    topic: {
      type: "choice",
      instructions: "i",
      criteria: { weather: "a", sports: "b" },
    },
    clarity: { type: "score", instructions: "i", criteria: ["0", "1", "2"] },
  } as const;

  it("unwraps result and parses answers by question type", () => {
    const { answers, usage } = parseJevOutput(ANSWER_QUESTIONS, jevResponse);
    expect(answers).toEqual({
      aboutWeather: { noul: 0.99 },
      topic: {
        choice: "weather",
        confidence: 1,
        probabilities: { weather: 1, sports: 0 },
      },
      clarity: {
        score: 1.97,
        confidence: 0.95,
        probabilities: { "0": 0.01, "1": 0.01, "2": 0.98 },
      },
    });
    expect(usage).toEqual({ inputTokens: 387, outputTokens: 65 });
    // The old top-level shape is not accepted.
    expect(() => parseJevOutput(ANSWER_QUESTIONS, jevResponse.result)).toThrow(
      ResponseParseError,
    );
  });

  it("rejects a response whose state is not Completed", () => {
    expect(() =>
      parseJevOutput(ANSWER_QUESTIONS, { ...jevResponse, state: "Failed" }),
    ).toThrow(/Failed/);
    expect(() =>
      parseJevOutput(ANSWER_QUESTIONS, { state: "Running" }),
    ).toThrow(ResponseParseError);
  });
});
