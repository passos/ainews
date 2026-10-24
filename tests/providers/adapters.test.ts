import { describe, expect, it } from "vitest";
import {
  ResponseParseError,
  UnsupportedModelError,
  buildTextInput,
  parseTextOutput,
} from "../../src/providers/adapters";
import {
  anthropicResponse,
  googleResponse,
  googleWrappedResponse,
  openaiResponse,
} from "./fixtures";

const REQUEST = { system: "sys", prompt: "hi", maxOutputTokens: 64 };

describe("text adapters", () => {
  it("anthropic: joins text parts and reads usage", () => {
    expect(buildTextInput("anthropic/claude-sonnet-5.5", REQUEST)).toEqual({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 64,
    });
    const out = parseTextOutput(
      "anthropic/claude-sonnet-5.5",
      anthropicResponse,
    );
    expect(out.text).toBe("Hello, world");
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
    expect(out.raw).toBe(anthropicResponse);
  });

  it("google: joins parts and counts thoughts as output", () => {
    expect(buildTextInput("google/gemini-3.8-flash", REQUEST)).toEqual({
      systemInstruction: { parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    const out = parseTextOutput("google/gemini-3.8-flash", googleResponse);
    expect(out.text).toBe("OK");
    // No candidatesTokenCount: output is the 94 thinking tokens.
    expect(out.usage).toEqual({ inputTokens: 8, outputTokens: 94 });
  });

  it("google: adds candidates and thoughts, skips parts without text", () => {
    const out = parseTextOutput("google/gemini-3.8-flash", {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "Hi ", thoughtSignature: "sig" },
              { functionCall: {} },
              { text: "there" },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
      },
    });
    expect(out.text).toBe("Hi there");
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 8 });
    expect(() =>
      parseTextOutput("google/gemini-3.8-flash", {
        ...googleResponse,
        usageMetadata: { thoughtsTokenCount: 94 },
      }),
    ).toThrow(/promptTokenCount/);
  });

  it("google: reads finishReason of the first candidate", () => {
    const out = parseTextOutput("google/gemini-3.8-flash", googleResponse);
    expect(out.finishReason).toBe("STOP");
  });

  it("google: a thinking-only cut-off names finishReason in the parse error", () => {
    const usageMetadata = {
      promptTokenCount: 3412,
      thoughtsTokenCount: 1918,
      totalTokenCount: 5330,
    };
    const cutOff = {
      candidates: [{ finishReason: "MAX_TOKENS" }],
      usageMetadata,
    };
    const model = "google/gemini-3.8-flash";
    expect(() => parseTextOutput(model, cutOff)).toThrow(ResponseParseError);
    expect(() => parseTextOutput(model, cutOff)).toThrow(
      "candidates[0].content: expected an object (finishReason MAX_TOKENS)",
    );
    const wrapped = { state: "Completed", result: cutOff };
    expect(() => parseTextOutput(model, wrapped)).toThrow(
      "candidates[0].content: expected an object (finishReason MAX_TOKENS)",
    );
  });

  it("google: a missing content without finishReason keeps the plain message", () => {
    const usageMetadata = { promptTokenCount: 3412, thoughtsTokenCount: 1918 };
    const model = "google/gemini-3.8-flash";
    for (const raw of [
      { candidates: [{}], usageMetadata },
      { state: "Completed", result: { candidates: [{}], usageMetadata } },
    ]) {
      expect(() => parseTextOutput(model, raw)).toThrow(ResponseParseError);
      expect(() => parseTextOutput(model, raw)).toThrow(
        /^candidates\[0\]\.content: expected an object$/,
      );
    }
  });

  it("google: a {state: Completed, result} envelope is parsed as its result", () => {
    const out = parseTextOutput(
      "google/gemini-3.8-flash",
      googleWrappedResponse,
    );
    expect(out.text).toBe('{"title": "MIT researchers design a nuclear');
    expect(out.usage).toEqual({ inputTokens: 3412, outputTokens: 78 + 1918 });
    expect(out.finishReason).toBe("MAX_TOKENS");
    expect(out.raw).toBe(googleWrappedResponse);
  });

  it("google: an envelope in another state throws and names the state", () => {
    const running = { state: "Running", result: {} };
    expect(() => parseTextOutput("google/gemini-3.8-flash", running)).toThrow(
      ResponseParseError,
    );
    expect(() => parseTextOutput("google/gemini-3.8-flash", running)).toThrow(
      /Running/,
    );
  });

  it("google: thinkingConfig goes into generationConfig only when given", () => {
    const thinkingConfig = { thinkingBudget: 128 };
    const input = buildTextInput("google/gemini-3.8-flash", {
      ...REQUEST,
      thinkingConfig,
    });
    expect(input.generationConfig).toStrictEqual({
      maxOutputTokens: 64,
      thinkingConfig,
    });
    const plain = buildTextInput("google/gemini-3.8-flash", REQUEST);
    expect(plain.generationConfig).toStrictEqual({ maxOutputTokens: 64 });
  });

  it("openai: chat completions", () => {
    expect(buildTextInput("openai/gpt-5.5", REQUEST)).toEqual({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      max_completion_tokens: 64,
    });
    const out = parseTextOutput("openai/gpt-5.5", openaiResponse);
    expect(out.text).toBe("Bonjour");
    expect(out.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("rejects other prefixes", () => {
    expect(() => buildTextInput("meta/llama", REQUEST)).toThrow(
      UnsupportedModelError,
    );
    expect(() => parseTextOutput("@cf/baai/bge-m3", {})).toThrow(
      UnsupportedModelError,
    );
  });

  it("names the missing field on a malformed response", () => {
    expect(() =>
      parseTextOutput("openai/gpt-5.5", { choices: [], usage: {} }),
    ).toThrow(ResponseParseError);
  });
});
