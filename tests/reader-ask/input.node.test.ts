import { describe, expect, it } from "vitest";
import { ReaderAskError } from "../../src/server/reader-ask/errors";
import {
  parseAnswerInput,
  parseAskInput,
} from "../../src/server/reader-ask/input";

function codeOf(fn: () => unknown): { status: number; code: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ReaderAskError);
    const err = e as ReaderAskError;
    return { status: err.status, code: err.code };
  }
}

describe("parseAskInput", () => {
  it("trims and collapses whitespace", () => {
    expect(
      parseAskInput({ eventId: 3, question: "  What   did\n\tthey ship?  " }),
    ).toEqual({ eventId: 3, question: "What did they ship?" });
  });

  it("accepts 10 and 300 characters after normalisation", () => {
    expect(
      parseAskInput({ eventId: 1, question: "a".repeat(10) }).question,
    ).toHaveLength(10);
    expect(
      parseAskInput({ eventId: 1, question: "a".repeat(300) }).question,
    ).toHaveLength(300);
  });

  it("refuses fewer than 10 or more than 300 characters with 400", () => {
    for (const question of [
      "a".repeat(9),
      `  ${"a".repeat(9)}   `,
      "a".repeat(301),
    ]) {
      expect(codeOf(() => parseAskInput({ eventId: 1, question }))).toEqual({
        status: 400,
        code: "invalid_input",
      });
    }
  });

  it("refuses a raw question over 400 characters with 413", () => {
    expect(
      codeOf(() => parseAskInput({ eventId: 1, question: "a".repeat(401) })),
    ).toEqual({ status: 413, code: "payload_too_large" });
    // 400 raw characters that normalise to 10 are fine.
    expect(
      parseAskInput({
        eventId: 1,
        question: `${"a".repeat(10)}${" ".repeat(390)}`,
      }).question,
    ).toBe("a".repeat(10));
  });

  it("refuses unknown fields and bad event ids", () => {
    for (const raw of [
      { eventId: 1, question: "a".repeat(20), extra: 1 },
      { eventId: 0, question: "a".repeat(20) },
      { eventId: 1.5, question: "a".repeat(20) },
      { eventId: "1", question: "a".repeat(20) },
      null,
    ]) {
      expect(codeOf(() => parseAskInput(raw))).toEqual({
        status: 400,
        code: "invalid_input",
      });
    }
  });
});

describe("parseAnswerInput", () => {
  it("accepts a question id and a token string", () => {
    expect(parseAnswerInput({ questionId: 4, token: "t" })).toEqual({
      questionId: 4,
      token: "t",
    });
  });

  it("refuses unknown fields", () => {
    expect(
      codeOf(() => parseAnswerInput({ questionId: 4, token: "t", x: 1 })),
    ).toEqual({ status: 400, code: "invalid_input" });
  });
});
