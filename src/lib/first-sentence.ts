// The first sentence of a paragraph, for one-line display (#87). Pure string
// code: it ships to the client.

/**
 * Text up to and including the first ". " (period and space), trimmed. Text
 * without one is a single sentence. A result longer than `max` characters is
 * cut to `max` including a final "…", at a word boundary when there is one.
 */
export function firstSentence(text: string, max = 220): string {
  const t = text.trim();
  const end = t.indexOf(". ");
  const sentence = end === -1 ? t : t.slice(0, end + 1);
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
