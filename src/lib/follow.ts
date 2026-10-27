// Pure logic for /follow (#132): validation, error copy, token extraction and
// the switch guards. No storage, no navigation: the feed address lives only in
// component state (tests/follow.node.test.ts reads this file to check that).
import { notFound } from "@tanstack/react-router";
import {
  readerWatchInput,
  type ReaderWatchInput,
} from "../server/reader-watch/input";
import { FINANCE_SLUG } from "./sections";

export const FOLLOW_COPY = {
  savedOnce:
    "Save this address now. It is shown only once. Anyone with it can read this feed.",
  addToReader:
    "Add it to your RSS reader. The feed lists a story only when newly approved reporting meets your criteria.",
  stored:
    "Your question, criteria and keywords are stored in plain text. The question and criteria are sent to our model provider to check new reporting. They are kept after the watch is stopped; deleting them is not available yet.",
  stopped: "This feed is stopped.",
  unavailable: "Watches are not available right now.",
} as const;

const CREATE_MESSAGES: Record<string, string> = {
  per_network_limit:
    "You have created 3 watches from this network today. Try again tomorrow.",
  capacity_full: "Reader watches are full right now. Try again later.",
  payload_too_large: "That text is too long. Shorten it and try again.",
  invalid_input: "Check the form and try again.",
  unknown_section: "Check the form and try again.",
  section_not_allowed: "Check the form and try again.",
};

/** reader_watch_disabled, unavailable, anything else, and no code at all. */
export function createErrorMessage(code: string | null): string {
  return (code !== null && CREATE_MESSAGES[code]) || FOLLOW_COPY.unavailable;
}

export function revokeErrorMessage(code: string | null): string {
  if (code === "not_found") return "We could not find this feed.";
  return FOLLOW_COPY.unavailable;
}

export function parseKeywords(text: string): string[] {
  return text
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
}

type Section = { slug: string; name: string };

/** The server refuses Finance, so the form does not offer it. */
export function followSectionOptions<T extends Section>(sections: T[]): T[] {
  return sections.filter((s) => s.slug.trim().toLowerCase() !== FINANCE_SLUG);
}

export type FieldName = "question" | "criteria" | "keywords";
export type FieldErrors = Partial<Record<FieldName, string>>;

export interface FollowFields {
  question: string;
  criteria: string;
  keywords: string;
  /** "" means all sections. */
  industrySlug: string;
}

const CHARS = "Use letters, numbers and basic punctuation only.";

function fieldMessage(
  field: FieldName,
  path: readonly PropertyKey[],
  code: string,
): string {
  const length = code === "too_small" || code === "too_big";
  if (field === "question") return length ? "Use 10 to 200 characters." : CHARS;
  if (field === "criteria") return length ? "Use 10 to 300 characters." : CHARS;
  if (path.length === 1) return "Add 1 to 5 keywords, separated by commas.";
  return length ? "Each keyword needs 2 to 40 characters." : CHARS;
}

/** Runs the server schema in the browser, so a 400 can name its field. */
export function validateFollow(
  f: FollowFields,
): { ok: true; input: ReaderWatchInput } | { ok: false; errors: FieldErrors } {
  const result = readerWatchInput.safeParse({
    question: f.question,
    criteria: f.criteria,
    keywords: parseKeywords(f.keywords),
    industrySlug: f.industrySlug === "" ? null : f.industrySlug,
  });
  if (result.success) return { ok: true, input: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (field !== "question" && field !== "criteria" && field !== "keywords") {
      continue;
    }
    errors[field] ??= fieldMessage(field, issue.path, issue.code);
  }
  return { ok: false, errors };
}

const FEED_PATH = /\/rss\/p\/([A-Za-z0-9_-]{43})\.xml(?:[?#].*)?$/;

/** The token in a pasted private feed address, or null. */
export function extractFeedToken(text: string): string | null {
  return FEED_PATH.exec(text.trim())?.[1] ?? null;
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

export type CreateResult =
  | { kind: "ok"; feedUrl: string }
  | { kind: "fields"; errors: FieldErrors }
  | { kind: "error"; message: string };

export async function submitCreate(
  fields: FollowFields,
  create: (input: ReaderWatchInput) => Promise<unknown>,
): Promise<CreateResult> {
  const checked = validateFollow(fields);
  if (!checked.ok) return { kind: "fields", errors: checked.errors };
  let result: unknown;
  try {
    result = await create(checked.input);
  } catch (e) {
    return { kind: "error", message: createErrorMessage(await failureCode(e)) };
  }
  const feedUrl = (result as { feedUrl?: unknown } | null)?.feedUrl;
  if (typeof feedUrl === "string") return { kind: "ok", feedUrl };
  return { kind: "error", message: createErrorMessage(codeOf(result)) };
}

export type RevokeResult = { kind: "ok" } | { kind: "error"; message: string };

export async function submitRevoke(
  address: string,
  revoke: (token: string) => Promise<unknown>,
): Promise<RevokeResult> {
  const token = extractFeedToken(address);
  if (token === null) {
    return {
      kind: "error",
      message: "Paste the full feed address, ending in .xml.",
    };
  }
  try {
    const result = await revoke(token);
    const code = codeOf(result);
    if (code !== null)
      return { kind: "error", message: revokeErrorMessage(code) };
    return { kind: "ok" };
  } catch (e) {
    return { kind: "error", message: revokeErrorMessage(await failureCode(e)) };
  }
}

/** The header links to /w while a public watch exists or /follow is open. */
export function showWatchesNav(shell: {
  hasWatches: boolean;
  readerWatchEnabled: boolean;
}): boolean {
  return shell.hasWatches || shell.readerWatchEnabled;
}

/** /follow is a 404 while the switch is off. */
export function resolveFollowShell<T extends Section>(shell: {
  readerWatchEnabled: boolean;
  sections: T[];
}): { sections: T[] } {
  if (!shell.readerWatchEnabled) throw notFound();
  return { sections: followSectionOptions(shell.sections) };
}
