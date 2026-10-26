// Text fragment links (`#:~:text=`) for evidence quotes (#86). Pure string
// code: it ships to the client, so no markdown-it here.

/** The quote as plain words: markdown marks removed, spaces collapsed. */
function plainQuote(quote: string): string {
  return quote
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]|~~/g, "")
    .replace(/^[ \t]*[#>-]+/gm, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// `-`, `,` and `&` are text directive syntax. encodeURIComponent encodes `,`
// and `&` but not `-`.
const enc = (s: string) => encodeURIComponent(s).replace(/-/g, "%2D");

/** `text=…` for the quote; a start,end range when it has more than 8 words. */
function textDirective(quote: string): string | null {
  const text = plainQuote(quote);
  if (!text) return null;
  const words = text.split(" ");
  return words.length <= 8
    ? `text=${enc(text)}`
    : `text=${enc(words.slice(0, 4).join(" "))},${enc(words.slice(-4).join(" "))}`;
}

/** Reader page link that highlights the quote. */
export function textFragmentHref(articleId: number, quote: string): string {
  const directive = textDirective(quote);
  return directive ? `/a/${articleId}#:~:${directive}` : `/a/${articleId}`;
}

/** Original article link that highlights the quote; keeps an existing fragment. */
export function originalFragmentHref(url: string, quote: string): string {
  const directive = textDirective(quote);
  if (!directive) return url;
  return url.includes("#") ? `${url}:~:${directive}` : `${url}#:~:${directive}`;
}
