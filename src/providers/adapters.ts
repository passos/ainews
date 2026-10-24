// Request and response formats per model family, for the text slots
// (`write`, `reason`). Field names come from the model pages and are
// assumptions until scripts/smoke-models.ts confirms them.
//
// No runtime imports here: scripts/smoke-models.ts loads this file in Node.

export interface TextRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Google only: sent as generationConfig.thinkingConfig when set. */
  thinkingConfig?: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface TextResult {
  text: string;
  usage: Usage;
  /** Google only: candidates[0].finishReason, e.g. "STOP" or "MAX_TOKENS". */
  finishReason?: string;
  raw: unknown;
}

export class UnsupportedModelError extends Error {
  constructor(model: string) {
    super(`no adapter for model "${model}"`);
    this.name = "UnsupportedModelError";
  }
}

export class ResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseParseError";
  }
}

type Family = "anthropic" | "google" | "openai";

function family(model: string): Family {
  const prefix = model.slice(0, model.indexOf("/"));
  if (prefix === "anthropic" || prefix === "google" || prefix === "openai") {
    return prefix;
  }
  throw new UnsupportedModelError(model);
}

export function buildTextInput(
  model: string,
  request: TextRequest,
): Record<string, unknown> {
  const { system, prompt, maxOutputTokens, thinkingConfig } = request;
  switch (family(model)) {
    case "anthropic":
      return {
        system,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxOutputTokens,
      };
    case "google":
      return {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig:
          thinkingConfig === undefined
            ? { maxOutputTokens }
            : { maxOutputTokens, thinkingConfig },
      };
    case "openai":
      return {
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        max_completion_tokens: maxOutputTokens,
      };
  }
}

export function parseTextOutput(model: string, raw: unknown): TextResult {
  switch (family(model)) {
    case "anthropic": {
      const body = record(raw, "response");
      const text = array(body.content, "content")
        .map((part, i) => record(part, `content[${i}]`))
        .filter((part) => part.type === "text")
        .map((part, i) => string(part.text, `content[${i}].text`))
        .join("");
      const usage = record(body.usage, "usage");
      return {
        text,
        usage: {
          inputTokens: number(usage.input_tokens, "usage.input_tokens"),
          outputTokens: number(usage.output_tokens, "usage.output_tokens"),
        },
        raw,
      };
    }
    case "google": {
      const body = googleBody(record(raw, "response"));
      const candidate = record(
        array(body.candidates, "candidates")[0],
        "candidates[0]",
      );
      const content = record(candidate.content, "candidates[0].content");
      const text = array(content.parts, "candidates[0].content.parts")
        .map((part, i) => record(part, `parts[${i}]`))
        .filter((part) => part.text !== undefined)
        .map((part, i) => string(part.text, `parts[${i}].text`))
        .join("");
      const usage = record(body.usageMetadata, "usageMetadata");
      // Thinking tokens are billed as output. A thinking-only reply has no
      // candidatesTokenCount.
      const count = (field: string): number =>
        usage[field] === undefined ? 0 : number(usage[field], field);
      const finishReason =
        candidate.finishReason === undefined
          ? undefined
          : string(candidate.finishReason, "candidates[0].finishReason");
      return {
        text,
        usage: {
          inputTokens: number(usage.promptTokenCount, "promptTokenCount"),
          outputTokens:
            count("candidatesTokenCount") + count("thoughtsTokenCount"),
        },
        finishReason,
        raw,
      };
    }
    case "openai": {
      const body = record(raw, "response");
      const choice = record(array(body.choices, "choices")[0], "choices[0]");
      const message = record(choice.message, "choices[0].message");
      const usage = record(body.usage, "usage");
      return {
        text: string(message.content, "choices[0].message.content"),
        usage: {
          inputTokens: number(usage.prompt_tokens, "usage.prompt_tokens"),
          outputTokens: number(
            usage.completion_tokens,
            "usage.completion_tokens",
          ),
        },
        raw,
      };
    }
  }
}

/**
 * The gateway sometimes wraps the body in `{ state, result }` (llm_calls
 * id 175). Only a completed result is parsed.
 */
function googleBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!("state" in body && "result" in body)) return body;
  if (body.state !== "Completed") {
    throw new ResponseParseError(
      `response state ${JSON.stringify(body.state)}: expected "Completed"`,
    );
  }
  return record(body.result, "result");
}

// Narrowing helpers. Each throws ResponseParseError naming the bad field.

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResponseParseError(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ResponseParseError(`${path}: expected an array`);
  }
  return value;
}

export function string(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ResponseParseError(`${path}: expected a string`);
  }
  return value;
}

export function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ResponseParseError(`${path}: expected a number`);
  }
  return value;
}
