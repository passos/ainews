// Reader watch input (architecture §6 "读者 watch" 输入). Order: raw length
// check (413), then NFC + whitespace normalization, then the strict schema.
import { z } from "zod";
import { ReaderWatchError } from "./errors";

/** Allowed characters for question, criteria and keywords. */
export const READER_TEXT_RE = /^[\p{L}\p{M}\p{N} .,;:!?'()\-–—/&%$#+@*]+$/u;

/** Raw lengths, checked before normalization. Over them: 413. */
export const READER_RAW_MAX = { question: 400, criteria: 600, keyword: 80 };

export function normalizeReaderText(s: string): string {
  return s.normalize("NFC").trim().replace(/\s+/g, " ");
}

const readerText = (min: number, max: number) =>
  z
    .string()
    .transform(normalizeReaderText)
    .pipe(z.string().min(min).max(max).regex(READER_TEXT_RE));

function dedupeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  return keywords.filter((k) => {
    const key = k.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const readerWatchInput = z
  .object({
    question: readerText(10, 200),
    criteria: readerText(10, 300),
    keywords: z
      .array(readerText(2, 40))
      .min(1)
      .max(5)
      .transform(dedupeKeywords),
    industrySlug: z.string().max(64).nullable(),
  })
  .strict();

export type ReaderWatchInput = z.output<typeof readerWatchInput>;

export const revokeInput = z.object({ token: z.string() }).strict();

export type RevokeInput = z.output<typeof revokeInput>;

const tooLong = (value: unknown, max: number) =>
  typeof value === "string" && value.length > max;

function checkRawLengths(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const r = raw as Record<string, unknown>;
  const over =
    tooLong(r.question, READER_RAW_MAX.question) ||
    tooLong(r.criteria, READER_RAW_MAX.criteria) ||
    (Array.isArray(r.keywords) &&
      r.keywords.some((k) => tooLong(k, READER_RAW_MAX.keyword)));
  if (over) throw new ReaderWatchError("payload_too_large", 413);
}

function strictParse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ReaderWatchError("invalid_input", 400);
  return result.data;
}

/** Throws ReaderWatchError 413 `payload_too_large` or 400 `invalid_input`. */
export function parseReaderWatchInput(raw: unknown): ReaderWatchInput {
  checkRawLengths(raw);
  return strictParse(readerWatchInput, raw);
}

/** Throws ReaderWatchError 400 `invalid_input`. */
export function parseRevokeInput(raw: unknown): RevokeInput {
  return strictParse(revokeInput, raw);
}
