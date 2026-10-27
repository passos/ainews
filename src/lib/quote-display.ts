// Display helpers for evidence quotes (#154). Pure string code: it ships to
// the client.

// A url longer than this is not treated as a link; it bounds the scan.
const MAX_URL_LENGTH = 2048;

/** Index just past the `)` that closes the `(` at `open`, or -1. */
function closingParen(s: string, open: number): number {
  const end = Math.min(s.length, open + 1 + MAX_URL_LENGTH);
  let depth = 0;
  for (let i = open; i < end; i++) {
    const ch = s[i];
    if (ch === "\n") return -1;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Quote text for display: markdown links `[text](url)` shown as `text`.
 * Display only. Link builders must keep the raw quote. Images, nested
 * brackets and unclosed links stay as they are.
 */
export function stripMarkdownLinks(quote: string): string {
  let out = "";
  let i = 0;
  while (i < quote.length) {
    if (quote[i] === "[" && quote[i - 1] !== "!") {
      // The next `]` must come before any other `[`, so each scan is short.
      let j = i + 1;
      while (j < quote.length && quote[j] !== "]" && quote[j] !== "[") j++;
      if (quote[j] === "]" && quote[j + 1] === "(") {
        const end = closingParen(quote, j + 1);
        if (end !== -1) {
          out += quote.slice(i + 1, j);
          i = end;
          continue;
        }
      }
    }
    out += quote[i];
    i++;
  }
  return out;
}
