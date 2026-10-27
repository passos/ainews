// Client side of "Ask about this story" (#133): reader copy, input check,
// error messages and the answer polling loop. The server functions are
// injected, so this file has no server or env imports.
import type { StoryAnswer } from "../server/reader-ask/ask";
import type { AskInput } from "../server/reader-ask/input";

export const ASK_COPY = {
  title: "Ask about this story",
  intro:
    "Ask one question. The answer uses only the approved reports on this page.",
  researching: "Researching approved sources…",
  answerLabel: "Model answer · not editor-reviewed",
  answerNote: "Check it against the quoted sources below.",
  verified: "Verified quotes",
  unverified: "Could not verify",
  refusal: "We could not answer this from approved sources.",
  dailyLimit: "Today's question limit has been reached.",
  timeout: "This is taking longer than expected. Try again later.",
  failed: "We could not answer this question. Try again later.",
  generic: "Something went wrong. Try again later.",
  tooShort: "Write 10 to 300 characters.",
} as const;

export const ASK_POLL = { intervalMs: 3000, maxMs: 120_000 } as const;

const MIN = 10;
const MAX = 300;

export type AskState =
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "done"; answer: StoryAnswer }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export function askErrorMessage(code: string | null): string {
  switch (code) {
    case "daily_limit":
      return ASK_COPY.dailyLimit;
    case "invalid_input":
    case "payload_too_large":
      return ASK_COPY.tooShort;
    case "ask_disabled":
    case "section_not_allowed":
    case "not_found":
      return "Questions are not available for this story.";
    default:
      return ASK_COPY.generic;
  }
}

function codeOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { error?: unknown }).error;
  return typeof code === "string" ? code : null;
}

// A server function error reaches the client as a thrown Response with a JSON
// body {"error": code}; some paths resolve with that body instead.
async function failureCode(e: unknown): Promise<string | null> {
  if (!(e instanceof Response)) return null;
  try {
    return codeOf(await e.clone().json());
  } catch {
    return null;
  }
}

export type SubmitResult =
  | { kind: "ok"; questionId: number; token: string }
  | { kind: "error"; message: string };

export async function submitAsk(
  eventId: number,
  text: string,
  ask: (input: AskInput) => Promise<unknown>,
): Promise<SubmitResult> {
  const question = text.normalize("NFC").trim().replace(/\s+/g, " ");
  if (question.length < MIN || question.length > MAX) {
    return { kind: "error", message: ASK_COPY.tooShort };
  }
  let result: unknown;
  try {
    result = await ask({ eventId, question });
  } catch (e) {
    return { kind: "error", message: askErrorMessage(await failureCode(e)) };
  }
  const r = result as { questionId?: unknown; token?: unknown } | null;
  if (typeof r?.questionId === "number" && typeof r.token === "string") {
    return { kind: "ok", questionId: r.questionId, token: r.token };
  }
  return { kind: "error", message: askErrorMessage(codeOf(result)) };
}

export type PollResult =
  | { kind: "done"; answer: StoryAnswer }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls every ASK_POLL.intervalMs until the answer is final or maxMs. */
export async function pollAnswer(
  poll: () => Promise<unknown>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<PollResult> {
  const sleep = opts.sleep ?? wait;
  for (
    let waited = ASK_POLL.intervalMs;
    waited <= ASK_POLL.maxMs;
    waited += ASK_POLL.intervalMs
  ) {
    await sleep(ASK_POLL.intervalMs);
    let result: unknown;
    try {
      result = await poll();
    } catch (e) {
      return { kind: "error", message: askErrorMessage(await failureCode(e)) };
    }
    const status = (result as { status?: unknown } | null)?.status;
    if (status === "completed") {
      return { kind: "done", answer: result as StoryAnswer };
    }
    if (status === "failed") {
      return { kind: "error", message: ASK_COPY.failed };
    }
    if (status !== "pending" && status !== "processing") {
      return { kind: "error", message: askErrorMessage(codeOf(result)) };
    }
  }
  return { kind: "timeout" };
}
