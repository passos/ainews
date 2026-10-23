// env.AI.toMarkdown() for fetch ladder rungs 0 and 2. HTML and PDF are free
// conversions, so this is not a model call: no ledger, no budget, and only
// COLLECT_ENABLED applies (checked by the caller).
//
// No runtime imports here: scripts/smoke-body.ts loads this file in Node.

export type MarkdownMime = "text/html" | "application/pdf";

/** The markdown, or null if the conversion reports an error. */
export async function toMarkdown(
  ai: Pick<Ai, "toMarkdown">,
  bytes: Uint8Array,
  mime: MarkdownMime,
  /** Full URL of the page; relative links resolve against it. */
  baseUrl: string,
): Promise<string | null> {
  const result = await ai.toMarkdown(
    {
      name: mime === "application/pdf" ? "doc.pdf" : "page.html",
      blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
    },
    {
      conversionOptions: {
        html: { hostname: baseUrl },
        pdf: { metadata: false },
      },
    },
  );
  return result.format === "error" ? null : result.data;
}
