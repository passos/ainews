import { describe, expect, it } from "vitest";
import {
  ResponseParseError,
  UnsupportedModelError,
  buildTextInput,
  parseTextOutput,
} from "../../src/providers/adapters";
import { anthropicResponse, googleResponse, openaiResponse } from "./fixtures";

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
