// Quote matching for artifacts (#131). Pure: the pipeline checks quotes
// against article bodies with it, and public cards check a subject against
// a stored sentence with the same rule.

/** Collapses whitespace only: case is kept, so "50 MW" does not match "50 mW". */
export function normalizeSourceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const DIGIT = /^\p{N}$/u;
const NUMBER_JOINER = /^[.,]$/;
const SPACE = /\s/;

/** One end of a match: `edge` is the needle's end character, `out` and
 * `beyond` the next two body characters outward ("" past the body end). */
function edgeIsBoundary(edge: string, out: string, beyond: string): boolean {
  if (WORD_CHAR.test(out)) return false;
  // "." or "," between two digits is part of one number: "150.50", "1,200".
  return !(DIGIT.test(edge) && NUMBER_JOINER.test(out) && DIGIT.test(beyond));
}

/**
 * The first match of `needle` in `text` after normalising both, as offsets
 * [start, end) into the original `text`; null without one. A match must sit
 * at word boundaries: the body character next to each end of the needle must
 * not be a letter or digit, so "50 mW" does not match inside "150 mW", and a
 * digit end must not continue a number through "." or "," ("50 mW" in
 * "150.50 mW", "200" in "1,200"). Every occurrence is tried, so an earlier
 * hit inside a word does not hide a later valid one.
 */
function findQuote(
  text: string,
  needle: string,
): { start: number; end: number } | null {
  const n = normalizeSourceText(needle);
  if (n.length === 0) return null;
  // The normalised body, and for each of its code units the index of the
  // original code unit it stands for.
  let body = "";
  const at: number[] = [];
  let space = -1;
  for (let i = 0; i < text.length; i++) {
    if (SPACE.test(text[i])) {
      if (body.length > 0 && space < 0) space = i;
      continue;
    }
    if (space >= 0) {
      body += " ";
      at.push(space);
      space = -1;
    }
    body += text[i];
    at.push(i);
  }
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
      return { start: at[i], end: at[i + n.length - 1] + 1 };
    }
  }
  return null;
}

/** True when `needle` is not empty and `text` contains it per `findQuote`. */
export function sourceTextContains(
  text: string | null | undefined,
  needle: string,
): boolean {
  return !!text && findQuote(text, needle) !== null;
}

const SENTENCE_END = /^[.!?]$/;
const CLOSER = /^["'”’)\]]$/;
const NEWLINE = /^[\n\r]$/;
const ABBREVIATIONS = new Set([
  "Mr",
  "Mrs",
  "Ms",
  "Dr",
  "Prof",
  "St",
  "Inc",
  "Corp",
  "Ltd",
  "Co",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "U.S",
  "U.K",
  "No",
]);
const INITIAL = /^\p{Lu}$/u;

/**
 * Sentences of `text` as [start, end) offsets, whitespace trimmed. Simple on
 * purpose: a sentence ends after ".", "!" or "?" (and one closing quote or
 * bracket) when whitespace follows, and always at a newline. A "." does not
 * end one after an abbreviation or a single capital letter ("J. Smith").
 * A "." between digits is never followed by whitespace, so "1.5" stays whole.
 * A wrong split can only cut at such punctuation, never inside a token.
 */
function sentences(text: string): [number, number][] {
  const out: [number, number][] = [];
  const push = (from: number, to: number) => {
    while (from < to && SPACE.test(text[from])) from++;
    while (to > from && SPACE.test(text[to - 1])) to--;
    if (from < to) out.push([from, to]);
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (NEWLINE.test(ch)) {
      push(start, i);
      start = i + 1;
      continue;
    }
    if (!SENTENCE_END.test(ch)) continue;
    const end = CLOSER.test(text[i + 1] ?? "") ? i + 2 : i + 1;
    if (!SPACE.test(text[end] ?? "")) continue;
    if (ch === ".") {
      const token = /\S*$/.exec(text.slice(start, i))?.[0] ?? "";
      if (ABBREVIATIONS.has(token) || INITIAL.test(token)) continue;
    }
    push(start, end);
    start = end;
  }
  push(start, text.length);
  return out;
}

/**
 * Every sentence of `text` that the match of `needle` touches, from the start
 * of the first to the end of the last, with whitespace normalised; null when
 * `needle` does not match per `findQuote`. The stored and shown quote is this
 * text, so a match on a substring cannot cut a sign, a unit or a name off.
 */
export function groundedSentences(
  text: string | null | undefined,
  needle: string,
): string | null {
  if (!text) return null;
  const match = findQuote(text, needle);
  if (!match) return null;
  const touched = sentences(text).filter(
    ([from, to]) => to > match.start && from < match.end,
  );
  return normalizeSourceText(
    text.slice(touched[0][0], touched[touched.length - 1][1]),
  );
}
