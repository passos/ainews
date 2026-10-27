import { localDate } from "../time";

// Quote matching for artifacts (#131). Pure: the pipeline checks quotes
// against article bodies with it, and public cards check a model date against
// the verified quote with the same rule.

/** Collapses whitespace only: case is kept, so "50 MW" does not match "50 mW". */
export function normalizeSourceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const DIGIT = /^\p{N}$/u;
const NUMBER_JOINER = /^[.,]$/;

/** One end of a match: `edge` is the needle's end character, `out` and
 * `beyond` the next two body characters outward ("" past the body end). */
function edgeIsBoundary(edge: string, out: string, beyond: string): boolean {
  // A punctuation edge cannot split a word, so it needs no boundary.
  if (!WORD_CHAR.test(edge)) return true;
  if (WORD_CHAR.test(out)) return false;
  // "." or "," between two digits is part of one number: "150.50", "1,200".
  return !(DIGIT.test(edge) && NUMBER_JOINER.test(out) && DIGIT.test(beyond));
}

/**
 * True when `needle` is not empty and occurs in `text` after normalising both,
 * at word boundaries: a letter or digit at an end of the needle must not have
 * a letter or digit next to it in the body, so "50 mW" does not match inside
 * "150 mW", and a digit there must not continue a number through "." or ","
 * ("50 mW" in "150.50 mW", "200" in "1,200"). Every occurrence is tried, so
 * an earlier hit inside a word does not hide a later valid one.
 */
export function sourceTextContains(
  text: string | null | undefined,
  needle: string,
): boolean {
  const n = normalizeSourceText(needle);
  if (n.length === 0 || !text) return false;
  const body = normalizeSourceText(text);
  const chars = Array.from(n);
  const first = chars[0];
  const last = chars[chars.length - 1];
  for (let i = body.indexOf(n); i !== -1; i = body.indexOf(n, i + 1)) {
    const before = Array.from(body.slice(Math.max(0, i - 4), i));
    const after = Array.from(body.slice(i + n.length, i + n.length + 4));
    if (
      edgeIsBoundary(first, before.at(-1) ?? "", before.at(-2) ?? "") &&
      edgeIsBoundary(last, after[0] ?? "", after[1] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

const MONTH =
  "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
/** YYYY, YYYY-MM, YYYY-MM-DD, "Month YYYY" or "Month D, YYYY". */
const DATE_FORM = new RegExp(
  `^(?:\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|${MONTH} (?:\\d{1,2}, )?\\d{4})$`,
);

/**
 * The date a timeline entry shows. The model's date is shown only when it has
 * a date form and its verified quote states it; otherwise the cited article's
 * publish date (UTC) from the database, or "Date not stated" without one.
 */
export function timelineDisplayDate(
  date: string,
  quote: string,
  publishedAt: number | null | undefined,
): string {
  if (DATE_FORM.test(date) && sourceTextContains(quote, date)) return date;
  return publishedAt == null
    ? "Date not stated"
    : `Reported ${localDate(publishedAt, "UTC")}`;
}
