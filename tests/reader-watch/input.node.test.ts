import { describe, expect, it } from "vitest";
import { ReaderWatchError } from "../../src/server/reader-watch/create";
import {
  normalizeReaderText,
  parseReaderWatchInput,
  parseRevokeInput,
} from "../../src/server/reader-watch/input";

const BASE = {
  question: "Will agent protocols converge this year?",
  criteria: "A shipped standard adopted by two large vendors.",
  keywords: ["agent"],
  industrySlug: null,
};

function errorOf(fn: () => unknown): ReaderWatchError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ReaderWatchError);
    return e as ReaderWatchError;
  }
  throw new Error("expected a ReaderWatchError");
}

const invalid = (raw: unknown) => {
  const e = errorOf(() => parseReaderWatchInput(raw));
  expect({ status: e.status, code: e.code }).toEqual({
    status: 400,
    code: "invalid_input",
  });
};

const tooLarge = (raw: unknown) => {
  const e = errorOf(() => parseReaderWatchInput(raw));
  expect({ status: e.status, code: e.code }).toEqual({
    status: 413,
    code: "payload_too_large",
  });
};

describe("reader watch input (#132)", () => {
  it("accepts the base input", () => {
    expect(parseReaderWatchInput(BASE)).toEqual(BASE);
  });

  it("rejects a question of 9 or 201 characters", () => {
    invalid({ ...BASE, question: "a".repeat(9) });
    invalid({ ...BASE, question: "a".repeat(201) });
    expect(
      parseReaderWatchInput({ ...BASE, question: "a".repeat(200) }).question,
    ).toHaveLength(200);
  });

  it("rejects criteria of 301 characters", () => {
    invalid({ ...BASE, criteria: "a".repeat(301) });
    expect(
      parseReaderWatchInput({ ...BASE, criteria: "a".repeat(300) }).criteria,
    ).toHaveLength(300);
  });

  it("checks raw lengths before normalization with 413", () => {
    // 401 raw characters, 20 after normalization.
    tooLarge({ ...BASE, question: `${"a".repeat(20)}${" ".repeat(381)}` });
    tooLarge({ ...BASE, criteria: `${"a".repeat(20)}${" ".repeat(581)}` });
    tooLarge({ ...BASE, keywords: [`ab${" ".repeat(79)}`] });
    // At the raw limits, normalization brings them into range.
    expect(
      parseReaderWatchInput({
        ...BASE,
        question: `${"a".repeat(20)}${" ".repeat(380)}`,
        criteria: `${"a".repeat(20)}${" ".repeat(580)}`,
        keywords: [`ab${" ".repeat(78)}`],
      }),
    ).toEqual({
      ...BASE,
      question: "a".repeat(20),
      criteria: "a".repeat(20),
      keywords: ["ab"],
    });
  });

  it("rejects characters outside the whitelist", () => {
    for (const ch of ['"', "`", "<", "{", "=", "‮", "​", "\u0007"]) {
      invalid({ ...BASE, question: `Will agents ${ch} converge?` });
      invalid({ ...BASE, criteria: `A shipped ${ch} standard.` });
      invalid({ ...BASE, keywords: [`ag${ch}nt`] });
    }
  });

  it("turns a newline into one space", () => {
    expect(normalizeReaderText("  line one\n  line two words ")).toBe(
      "line one line two words",
    );
    expect(
      parseReaderWatchInput({ ...BASE, question: "line one\nline two words" })
        .question,
    ).toBe("line one line two words");
  });

  it("applies NFC normalization", () => {
    expect(normalizeReaderText("café news")).toBe("café news");
  });

  it("needs 1 to 5 keywords of 2 to 40 characters", () => {
    invalid({ ...BASE, keywords: [] });
    invalid({ ...BASE, keywords: ["a1", "a2", "a3", "a4", "a5", "a6"] });
    invalid({ ...BASE, keywords: ["k".repeat(41)] });
    invalid({ ...BASE, keywords: ["k"] });
    expect(
      parseReaderWatchInput({ ...BASE, keywords: ["k".repeat(40)] }).keywords,
    ).toEqual(["k".repeat(40)]);
  });

  it("removes duplicate keywords without regard to case", () => {
    expect(
      parseReaderWatchInput({ ...BASE, keywords: ["AI", "ai"] }).keywords,
    ).toEqual(["AI"]);
  });

  it("rejects an unknown field", () => {
    invalid({ ...BASE, ip: "1.2.3.4" });
  });

  it("rejects a missing or wrong-typed field", () => {
    invalid(undefined);
    invalid({ ...BASE, industrySlug: undefined });
    invalid({ ...BASE, keywords: "agent" });
    invalid({ ...BASE, question: 42 });
  });

  it("accepts CJK text and keywords with symbols", () => {
    expect(
      parseReaderWatchInput({
        ...BASE,
        question: "中文问题需要至少十个字符吗是的",
        keywords: ["C#", "$TSLA", ".NET", "C++"],
        industrySlug: "technology",
      }),
    ).toEqual({
      ...BASE,
      question: "中文问题需要至少十个字符吗是的",
      keywords: ["C#", "$TSLA", ".NET", "C++"],
      industrySlug: "technology",
    });
  });
});

describe("revoke input (#132)", () => {
  it("accepts a token and rejects anything else", () => {
    expect(parseRevokeInput({ token: "abc" })).toEqual({ token: "abc" });
    for (const raw of [undefined, {}, { token: 1 }, { token: "a", x: 1 }]) {
      const e = errorOf(() => parseRevokeInput(raw));
      expect({ status: e.status, code: e.code }).toEqual({
        status: 400,
        code: "invalid_input",
      });
    }
  });
});
