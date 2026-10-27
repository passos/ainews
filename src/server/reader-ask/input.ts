// Public Ask input (#133). Order: raw length check (413), then NFC and
// whitespace normalization, then the strict schema.
import { z } from "zod";
import { normalizeReaderText } from "../reader-watch/input";
import { ReaderAskError } from "./errors";

/** Raw question length, checked before normalization. Over it: 413. */
export const READER_ASK_RAW_MAX = 400;

export const askInput = z
  .object({
    eventId: z.number().int().positive(),
    question: z
      .string()
      .transform(normalizeReaderText)
      .pipe(z.string().min(10).max(300)),
  })
  .strict();

export type AskInput = z.output<typeof askInput>;

export const answerInput = z
  .object({
    questionId: z.number().int().positive(),
    token: z.string().max(100),
  })
  .strict();

export type AnswerInput = z.output<typeof answerInput>;

function strictParse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ReaderAskError("invalid_input", 400);
  return result.data;
}

/** Throws ReaderAskError 413 `payload_too_large` or 400 `invalid_input`. */
export function parseAskInput(raw: unknown): AskInput {
  if (typeof raw === "object" && raw !== null) {
    const q = (raw as Record<string, unknown>).question;
    if (typeof q === "string" && q.length > READER_ASK_RAW_MAX) {
      throw new ReaderAskError("payload_too_large", 413);
    }
  }
  return strictParse(askInput, raw);
}

/** Throws ReaderAskError 400 `invalid_input`. */
export function parseAnswerInput(raw: unknown): AnswerInput {
  return strictParse(answerInput, raw);
}
