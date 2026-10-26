// Reader-visible text must be English. Finds CJK characters (ideographs and
// full-width punctuation) in source code, ignoring comments.
// Input: map of "src/..." path -> source. Output: one "file:line" per hit.

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

// Replaces `//` and `/* */` comments with spaces; keeps newlines so line
// numbers stay valid. Quote state is tracked so `"http://x"` is not a comment.
// Conservative: an apostrophe in JSX text may hide a later comment on the
// same line, which gives a false positive (loud), never a false negative.
export function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i++;
      } else if (c === quote) {
        quote = null;
      } else if (c === "\n" && quote !== "`") {
        quote = null;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return out;
}

export function findCjk(files: Map<string, string>): string[] {
  const hits: string[] = [];
  for (const [file, source] of files) {
    stripComments(source)
      .split("\n")
      .forEach((line, i) => {
        if (CJK.test(line)) hits.push(`${file}:${i + 1}`);
      });
  }
  return hits.sort();
}
