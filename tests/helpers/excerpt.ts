// Excerpt payloads from review (#86). Each has a known visible word count W,
// so a test can check the excerpt against cap = min(300, floor(W / 4)).

export const words = (marker: string, n: number) =>
  [marker, ...Array.from({ length: n - 1 }, () => "w")].join(" ");

/** Words a reader sees in rendered HTML: tags removed, alt text included. */
export function visibleWords(html: string | null): number {
  if (!html) return 0;
  return html
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<[^>]*>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

export const cap = (w: number) => Math.min(300, Math.floor(w / 4));

/** Ten 50-word paragraphs separated by bare \r: W = 500, cap 125. */
export const CR_ONLY = {
  src: Array.from({ length: 10 }, (_, i) => words(`CR${i + 1}MARK`, 50)).join(
    "\r\r",
  ),
  w: 500,
};

// A reference label of 40 words: invisible when the definition resolves,
// visible text when the definition is cut off.
const LABEL = Array.from({ length: 40 }, (_, i) => `label${i}`).join(" ");

/**
 * Ten paragraphs of 20 visible words, each ending in a reference link whose
 * label has 40 words; the definition is at the end. W = 10 x 21 = 210, cap 52.
 */
export const REF_DEFS = {
  src: [
    ...Array.from(
      { length: 10 },
      (_, i) => `${words(`REF${i + 1}MARK`, 20)} [link][${LABEL}]`,
    ),
    `[${LABEL}]: https://ok.example/ref`,
  ].join("\n\n"),
  w: 210,
};

/**
 * Five plain 20-word paragraphs, then one paragraph of 100 visible words
 * written as "a**b**c" (3 text nodes each). Real W = 200, cap 50; counting
 * text nodes gives W = 400, cap 100.
 */
export const INFLATED = {
  src: [
    ...Array.from({ length: 5 }, (_, i) => words(`INF${i + 1}MARK`, 20)),
    Array.from({ length: 100 }, () => "a**b**c").join(" "),
  ].join("\n\n"),
  w: 200,
};

/**
 * An image with a 200-word alt, then four 25-word paragraphs. Without alt
 * text W = 100, cap 25; the excerpt shows alt text, which must count.
 */
export const LONG_ALT = {
  src: [
    `![${Array.from({ length: 200 }, () => "alt").join(" ")}](https://i.example/p.png)`,
    ...Array.from({ length: 4 }, (_, i) => words(`ALT${i + 1}MARK`, 25)),
  ].join("\n\n"),
  w: 100,
};

export const PAYLOADS = { CR_ONLY, REF_DEFS, INFLATED, LONG_ALT };
