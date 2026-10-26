// Renders untrusted markdown (model output, source content) to HTML.
// Raw HTML is escaped, images are off, and only http/https links are kept.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: false });
md.disable(["image"]);
md.validateLink = (url) => /^https?:\/\//i.test(url.trim());
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet("rel", "nofollow noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

export function renderMarkdown(src: string): string {
  return md.render(src);
}

// ---------------------------------------------------------------------------
// Article bodies for the reader page (#86). Source content is untrusted and
// the CSP allows inline scripts, so this renderer is the only defence: its
// output is markdown-it's own markup plus the table scroll wrapper. Raw HTML
// never passes through: dangerous blocks are dropped whole, other tags are
// removed and their text is escaped. `html: true` only makes raw HTML arrive
// as html_block / html_inline tokens, which the rules below handle.
const articleMd = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false,
});
const escapeHtml = articleMd.utils.escapeHtml;

// Links and images both pass here first.
articleMd.validateLink = (url) => /^https?:\/\//i.test(url.trim());

const DANGEROUS =
  "script|style|iframe|form|object|embed|noscript|template|textarea|select|button|input|svg|math|frame|frameset|link|meta|base";
const DANGEROUS_BLOCK = new RegExp(`^<\\/?(${DANGEROUS})\\b`, "i");
const DANGEROUS_ELEMENT = new RegExp(
  `<(${DANGEROUS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  "gi",
);

/** The plain text of a raw HTML block; "" when it is dropped whole. */
function htmlBlockText(content: string): string {
  const head = content.trimStart();
  if (
    head.startsWith("<!--") ||
    head.startsWith("<?") ||
    head.startsWith("<!") ||
    DANGEROUS_BLOCK.test(head)
  ) {
    return "";
  }
  return content
    .replace(DANGEROUS_ELEMENT, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

articleMd.renderer.rules.html_inline = () => "";
articleMd.renderer.rules.html_block = (tokens, idx) => {
  const text = htmlBlockText(tokens[idx].content);
  return text ? `<p>${escapeHtml(text)}</p>\n` : "";
};
articleMd.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet("rel", "nofollow noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

interface ArticleEnv {
  /** false: images keep only their alt text (excerpt mode). */
  images?: boolean;
}

// The default rule computes `alt` from the child tokens; renderToken would
// output an empty alt.
const defaultImage = articleMd.renderer.rules.image!;
articleMd.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = String(token.attrGet("src") ?? "");
  if (
    (env as ArticleEnv | undefined)?.images === false ||
    !/^https:\/\//i.test(src)
  ) {
    return escapeHtml(token.content);
  }
  token.attrSet("loading", "lazy");
  token.attrSet("referrerpolicy", "no-referrer");
  return defaultImage(tokens, idx, options, env, self);
};

// Tables scroll inside their own container.
articleMd.renderer.rules.table_open = () =>
  '<div class="article-table"><table>\n';
articleMd.renderer.rules.table_close = () => "</table></div>\n";

/** Sanitised HTML of an article body. `images: false` in excerpt mode. */
export function renderArticleMarkdown(
  src: string,
  { images = true }: { images?: boolean } = {},
): string {
  return articleMd.render(src, { images } satisfies ArticleEnv);
}

const EXCERPT_MAX_WORDS = 300;
const EXCERPT_MAX_SHARE = 0.25;

type Token = ReturnType<typeof articleMd.parse>[number];

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Visible words of one token. Image alt text is in image.children: not counted. */
function tokenWords(t: Token): number {
  if (t.type === "inline") {
    let n = 0;
    for (const c of t.children ?? []) {
      if (c.type === "text" || c.type === "code_inline")
        n += countWords(c.content);
    }
    return n;
  }
  if (t.type === "fence" || t.type === "code_block")
    return countWords(t.content);
  if (t.type === "html_block") return countWords(htmlBlockText(t.content));
  return 0;
}

/**
 * The excerpt of a body: whole top-level blocks from the start, together at
 * most 25% of the body's words and at most 300 words. Null when not even the
 * first block with words fits: a paragraph is never cut.
 *
 * Known limit: reference link definitions at the end of the body
 * (`[x]: https://…`) are outside the excerpt's lines, so such links in the
 * excerpt show as plain text.
 */
export function excerptMarkdown(src: string): string | null {
  const tokens = articleMd.parse(src, {});
  const blocks: { words: number; endLine: number }[] = [];
  for (const t of tokens) {
    if (t.level === 0 && t.nesting !== -1 && t.map !== null) {
      blocks.push({ words: 0, endLine: t.map[1] });
    }
    const current = blocks[blocks.length - 1];
    if (current) current.words += tokenWords(t);
  }
  const total = blocks.reduce((n, b) => n + b.words, 0);
  const cap = Math.min(
    EXCERPT_MAX_WORDS,
    Math.floor(total * EXCERPT_MAX_SHARE),
  );

  let used = 0;
  let endLine = 0;
  for (const b of blocks) {
    if (used + b.words > cap) break;
    used += b.words;
    endLine = b.endLine;
  }
  if (used === 0) return null;
  return src.split("\n").slice(0, endLine).join("\n");
}
