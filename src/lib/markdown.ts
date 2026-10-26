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

// Every link parses, so a rejected one still has its text: the core rule
// below removes the link tags of anything but http(s) and keeps the words.
// Images are checked (https only) in the image rule.
articleMd.validateLink = () => true;
const SAFE_LINK = /^https?:\/\//i;

const DANGEROUS =
  "script|style|iframe|form|object|embed|noscript|template|textarea|select|button|input|svg|math|frame|frameset|link|meta|base";
const DANGEROUS_BLOCK = new RegExp(`^<\\/?(${DANGEROUS})\\b`, "i");
// Inline elements whose content is code or form chrome, not article text.
const DROPPED_INLINE = new RegExp(
  "^<(script|style|iframe|form|object|noscript|template|textarea|select|button|svg|math|frameset)\\b",
  "i",
);
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

type Token = ReturnType<typeof articleMd.parse>[number];

// Inline cleanup, after parsing: an inline <script> / <style> (and the like)
// is dropped with its content, as html_block does; a link with a non-http(s)
// target loses its tags and keeps its text.
function cleanInline(children: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < children.length; i++) {
    const t = children[i];
    const open =
      t.type === "html_inline" ? DROPPED_INLINE.exec(t.content) : null;
    if (open && !/\/>\s*$/.test(t.content)) {
      const close = new RegExp(`^<\\/${open[1]}\\s*>`, "i");
      while (
        i + 1 < children.length &&
        !(
          children[i + 1].type === "html_inline" &&
          close.test(children[i + 1].content)
        )
      ) {
        i++;
      }
      i++; // the closing tag, or past the end when there is none
      continue;
    }
    if (
      t.type === "link_open" &&
      !SAFE_LINK.test(String(t.attrGet("href") ?? ""))
    ) {
      // Links do not nest: the next link_close is this link's.
      const close = children.findIndex(
        (c, j) => j > i && c.type === "link_close",
      );
      if (close !== -1) children.splice(close, 1);
      continue;
    }
    out.push(t);
  }
  return out;
}

articleMd.core.ruler.push("article_clean_inline", (state) => {
  for (const t of state.tokens) {
    if (t.type === "inline" && t.children) t.children = cleanInline(t.children);
  }
});

articleMd.renderer.rules.html_inline = () => "";
articleMd.renderer.rules.html_block = (tokens, idx) => {
  const text = htmlBlockText(tokens[idx].content);
  return text ? `<p>${escapeHtml(text)}</p>\n` : "";
};
articleMd.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet("rel", "nofollow noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

type ArticleEnv = {
  /** false: images keep only their alt text (excerpt mode). */
  images?: boolean;
};

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
    // Same visible text the excerpt counts: raw HTML in the alt is dropped.
    return escapeHtml(inlineText(token.children ?? []));
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

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** What a reader sees of inline tokens: text, code and image alt text. */
function inlineText(children: Token[]): string {
  let out = "";
  for (const c of children) {
    if (c.type === "text" || c.type === "code_inline") out += c.content;
    else if (c.type === "image") out += inlineText(c.children ?? []);
    else if (c.type === "softbreak" || c.type === "hardbreak") out += " ";
  }
  return out;
}

/** Visible words of one token (image alt text counts: excerpts show it). */
function tokenWords(t: Token): number {
  if (t.type === "inline") return countWords(inlineText(t.children ?? []));
  if (t.type === "fence" || t.type === "code_block")
    return countWords(t.content);
  if (t.type === "html_block") return countWords(htmlBlockText(t.content));
  return 0;
}

// Block-level tags separate words; inline tags (a, em, strong, code) do not.
const BLOCK_TAG =
  /<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr|br|div|table|thead|tbody|tr|th|td)\b[^>]*>/gi;

/** Visible words of rendered HTML. */
function htmlWords(html: string): number {
  return countWords(html.replace(BLOCK_TAG, " ").replace(/<[^>]*>/g, ""));
}

/**
 * The excerpt of a body as sanitised HTML, without images (alt text only):
 * whole top-level blocks from the start, together at most 25% of the body's
 * visible words and at most 300 words. Null when not even the first block
 * with words fits: a paragraph is never cut. The kept tokens are rendered
 * from the one parse of the whole body, so reference links resolve.
 */
export function renderArticleExcerpt(src: string): string | null {
  const env: ArticleEnv = { images: false };
  const tokens = articleMd.parse(src, env);
  const blocks: { start: number; words: number }[] = [];
  tokens.forEach((t, i) => {
    if (t.level === 0 && t.nesting !== -1 && t.map !== null) {
      blocks.push({ start: i, words: 0 });
    }
    const current = blocks[blocks.length - 1];
    if (current) current.words += tokenWords(t);
  });
  const total = blocks.reduce((n, b) => n + b.words, 0);
  const cap = Math.min(
    EXCERPT_MAX_WORDS,
    Math.floor(total * EXCERPT_MAX_SHARE),
  );

  let used = 0;
  let kept = 0;
  for (const b of blocks) {
    if (used + b.words > cap) break;
    used += b.words;
    kept += 1;
  }
  if (used === 0) return null;
  const end = kept < blocks.length ? blocks[kept].start : tokens.length;
  const html = articleMd.renderer.render(
    tokens.slice(0, end),
    articleMd.options,
    env,
  );
  // Licensing is a hard rule: whatever the counting above got wrong, the
  // words a reader would see must fit the cap, or no excerpt is shown.
  return htmlWords(html) > cap ? null : html;
}
