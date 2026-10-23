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
