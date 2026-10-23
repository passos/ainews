// Typed wrapper around the Jev structured-evaluation model (`judge` slot).
// Input `{ state, questions }`, output `answers[name]` per question type
// (model page). The binding wraps the output:
// `{ state: "Completed", result: { model, answers, usage } }`
// (confirmed by scripts/smoke-models.ts).

// Explicit extension: scripts/smoke-models.ts loads this file in Node.
import { ResponseParseError, number, record, string } from "./adapters.ts";
import type { Usage } from "./adapters.ts";

export type JevQuestion =
  | {
      type: "noul";
      instructions: string;
      criteria?: { true?: string; false?: string };
    }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: readonly string[] };

export type JevQuestions = Record<string, JevQuestion>;

/** `title` is never truncated; `body`, then `summary`, are cut first. */
export interface JevState {
  title: string;
  summary?: string;
  body?: string;
  [field: string]: unknown;
}

export interface JevInput {
  state: JevState;
  questions: JevQuestions;
}

export type JevAnswer<Q extends JevQuestion> = Q extends { type: "noul" }
  ? { noul: number }
  : Q extends { type: "choice" }
    ? {
        choice: string;
        confidence: number;
        probabilities: Record<string, number>;
      }
    : {
        score: number;
        confidence: number;
        probabilities: Record<string, number>;
      };

export type JevAnswers<Q extends JevQuestions> = {
  [K in keyof Q]: JevAnswer<Q[K]>;
};

/** Context is 32,000 tokens; keep a margin for the estimate's error. */
export const JEV_MAX_INPUT_TOKENS = 30_000;

/** Rough token estimate used for truncation and budget reservations. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3);
}

/** Still over JEV_MAX_INPUT_TOKENS after `body` and `summary` are cut. */
export class JevInputTooLargeError extends RangeError {
  constructor(tokens: number) {
    super(
      `Jev input is about ${tokens} tokens after truncation; the limit is ${JEV_MAX_INPUT_TOKENS}`,
    );
    this.name = "JevInputTooLargeError";
  }
}

/**
 * Builds the request, cutting `state.body`, then `state.summary`, to fit.
 * Throws JevInputTooLargeError if the rest (title, other fields, questions)
 * is still too large.
 */
export function buildJevInput(
  state: JevState,
  questions: JevQuestions,
): JevInput {
  const input: JevInput = { state: { ...state }, questions };
  for (const field of ["body", "summary"] as const) {
    for (;;) {
      const over = estimateTokens(input) - JEV_MAX_INPUT_TOKENS;
      const value = input.state[field];
      if (over <= 0 || typeof value !== "string" || value === "") break;
      // Each removed character shortens the JSON by at least one character.
      input.state[field] = cut(value, value.length - over * 3);
    }
  }
  const tokens = estimateTokens(input);
  if (tokens > JEV_MAX_INPUT_TOKENS) throw new JevInputTooLargeError(tokens);
  return input;
}

/** First `length` UTF-16 units, without splitting a surrogate pair. */
function cut(value: string, length: number): string {
  let end = Math.max(0, length);
  const last = value.charCodeAt(end - 1);
  if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export interface JevResult<Q extends JevQuestions> {
  answers: JevAnswers<Q>;
  /** Null when the response has no usage block. */
  usage: Usage | null;
}

export function parseJevOutput<Q extends JevQuestions>(
  questions: Q,
  raw: unknown,
): JevResult<Q> {
  const result = unwrapResult(raw);
  const answers = record(result.answers, "result.answers");
  const parsed: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    const path = `result.answers.${name}`;
    const answer = record(answers[name], path);
    if (question.type === "noul") {
      parsed[name] = { noul: number(answer.noul, `${path}.noul`) };
    } else {
      const key = question.type;
      parsed[name] = {
        [key]:
          question.type === "choice"
            ? criterion(question.criteria, answer.choice, `${path}.choice`)
            : number(answer.score, `${path}.score`),
        confidence: number(answer.confidence, `${path}.confidence`),
        probabilities: probabilities(
          answer.probabilities,
          `${path}.probabilities`,
        ),
      };
    }
  }
  return { answers: parsed as JevAnswers<Q>, usage: readUsage(result) };
}

function unwrapResult(raw: unknown): Record<string, unknown> {
  const body = record(raw, "response");
  if (body.state !== undefined && body.state !== "Completed") {
    throw new ResponseParseError(
      `state: expected "Completed", got ${JSON.stringify(body.state)}`,
    );
  }
  return record(body.result, "result");
}

/** A choice must be one of the question's criteria keys. */
function criterion(
  criteria: Record<string, string>,
  value: unknown,
  path: string,
): string {
  const choice = string(value, path);
  if (!Object.hasOwn(criteria, choice)) {
    throw new ResponseParseError(
      `${path}: ${JSON.stringify(choice)} is not one of the criteria`,
    );
  }
  return choice;
}

function probabilities(value: unknown, path: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(record(value, path))) {
    out[key] = number(p, `${path}.${key}`);
  }
  return out;
}

function readUsage(result: Record<string, unknown>): Usage | null {
  if (result.usage === undefined) return null;
  const u = record(result.usage, "result.usage");
  return {
    inputTokens: number(u.input_tokens, "result.usage.input_tokens"),
    outputTokens:
      u.output_tokens === undefined
        ? 0
        : number(u.output_tokens, "result.usage.output_tokens"),
  };
}
