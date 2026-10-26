// Runs in the `workers` project, so it also shows markdown-it works in workerd.
import { describe, expect, it } from "vitest";
import {
  excerptWithinCap,
  renderArticleExcerpt,
  renderArticleMarkdown,
  renderMarkdown,
} from "../src/lib/markdown";
import {
  PAYLOADS,
  TAG_HEAVY,
  cap,
  htmlVisibleWords,
  visibleWords,
} from "./helpers/excerpt";

describe("renderMarkdown", () => {
  it("escapes a script tag", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  for (const src of [
    "[a](javascript:alert(1))",
    "[a](JaVaScRiPt:x)",
    "[a](data:text/html,x)",
    "[a](/relative)",
    "<javascript:alert(1)>",
    "[a][r]\n\n[r]: javascript:alert(1)",
  ]) {
    it(`drops the link in ${JSON.stringify(src)}`, () => {
      expect(renderMarkdown(src)).not.toContain("href=");
    });
  }

  it("escapes a raw img tag", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain(
      "<img",
    );
  });

  it("does not render images", () => {
    expect(renderMarkdown("![i](https://x.y/i.png)")).not.toContain("<img");
  });

  it("keeps an https link with rel", () => {
    const html = renderMarkdown("[ok](https://a.b)");
    expect(html).toContain('href="https://a.b"');
    expect(html).toContain('rel="nofollow noopener noreferrer"');
  });
});

describe("renderArticleMarkdown", () => {
  it("drops a script block and its text", () => {
    const html = renderArticleMarkdown("<script>alert(1)</script>\n\nafter");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("<p>after</p>");
  });

  for (const [src, tag] of [
    ["<iframe src=https://x></iframe>", "<iframe"],
    ["<form action=x><input></form>", "<form"],
    ["<form action=x><input></form>", "<input"],
    ["<style>body{}</style>", "<style"],
  ]) {
    it(`drops ${tag} from ${JSON.stringify(src)}`, () => {
      expect(renderArticleMarkdown(`${src}\n\nafter`)).not.toContain(tag);
    });
  }

  it("drops an unclosed script block whole", () => {
    // No </script>: the html_block runs to the end; its text must not show.
    const html = renderArticleMarkdown("<script>\nalert(1)\n\nmore text");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("drops a script nested in another raw HTML block, with its text", () => {
    const html = renderArticleMarkdown(
      "<div>Kept <script>alert(1)</script></div>",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("Kept");
  });

  it("keeps the text of other raw HTML but not the tag or its attributes", () => {
    const html = renderArticleMarkdown("<p onclick=x>Kept text</p>");
    expect(html).toContain("<p>Kept text</p>");
    expect(html).not.toContain("onclick");
  });

  it("drops inline raw HTML tags and event attributes, keeps the words", () => {
    const html = renderArticleMarkdown(
      'Hello <span onmouseover="alert(1)">world</span> more',
    );
    expect(html).not.toContain("<span");
    expect(html).not.toContain("onmouseover");
    expect(html).toContain("world");
  });

  for (const tag of ["script", "style"]) {
    it(`drops an inline <${tag}> with its content`, () => {
      const html = renderArticleMarkdown(
        `Hello <${tag}>alert(1)</${tag}> world`,
      );
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain(`<${tag}`);
      expect(html).toContain("Hello");
      expect(html).toContain("world");
    });
  }

  for (const src of [
    "[bad link](javascript:alert(1))",
    "[bad link](data:text/html,x)",
    "[bad link](/relative)",
    "[bad link][r]\n\n[r]: javascript:alert(1)",
  ]) {
    it(`keeps only the text of a rejected link: ${JSON.stringify(src)}`, () => {
      const html = renderArticleMarkdown(src);
      expect(html).toBe("<p>bad link</p>\n");
    });
  }

  it("drops a raw img tag with onerror", () => {
    const html = renderArticleMarkdown("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });

  it("keeps an https image, lazy, without referrer", () => {
    const html = renderArticleMarkdown("![a](https://i.example/p.png)");
    expect(html).toContain('src="https://i.example/p.png"');
    expect(html).toContain('alt="a"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  it("keeps only the alt text of an http image", () => {
    const html = renderArticleMarkdown("![b](http://i.example/p.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("b");
  });

  it("keeps only the alt text of an https image when images are off (excerpt)", () => {
    const html = renderArticleMarkdown(
      "![alt words](https://i.example/p.png)",
      {
        images: false,
      },
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("i.example");
    expect(html).toContain("alt words");
  });

  for (const src of [
    "[a](javascript:alert(1))",
    "[a](JaVaScRiPt:x)",
    "[a](data:text/html,x)",
    "[a](/relative)",
    "<javascript:alert(1)>",
    "[a][r]\n\n[r]: javascript:alert(1)",
  ]) {
    it(`drops the link in ${JSON.stringify(src)}`, () => {
      expect(renderArticleMarkdown(src)).not.toContain("href=");
    });
  }

  it("drops a javascript: image source", () => {
    const html = renderArticleMarkdown("![x](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
  });

  it("keeps an https link with rel", () => {
    const html = renderArticleMarkdown("[y](https://ok.example)");
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('rel="nofollow noopener noreferrer"');
  });

  it("wraps a table in the scroll container", () => {
    const html = renderArticleMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain('<div class="article-table"><table>');
    expect(html).toContain("</table></div>");
  });

  it("escapes a script inside a fence", () => {
    const html = renderArticleMarkdown("```\n<script>x</script>\n```");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
  });
});

const para = (n: number, words: number) =>
  Array.from({ length: words }, (_, i) => (i === 0 ? `P${n}MARK` : "w")).join(
    " ",
  );
const paras = (count: number, words: number) =>
  Array.from({ length: count }, (_, i) => para(i + 1, words)).join("\n\n");
const kept = (out: string | null) =>
  (out ?? "").match(/P\d+MARK/g)?.length ?? 0;

describe("renderArticleExcerpt", () => {
  it("keeps whole blocks up to 25% of the words", () => {
    // W = 500, cap = 125: two 50-word blocks.
    const out = renderArticleExcerpt(paras(10, 50));
    expect(kept(out)).toBe(2);
    expect(out).not.toContain("P3MARK");
  });

  it("uses 25% when it is below 300 words", () => {
    // W = 600, cap = 150.
    expect(kept(renderArticleExcerpt(paras(30, 20)))).toBe(7);
  });

  it("never keeps more than 300 words", () => {
    // W = 2000: 25% is 500, the 300-word cap wins. (At W = 1200 both
    // limits are 300, so that size cannot tell them apart.)
    expect(kept(renderArticleExcerpt(paras(100, 20)))).toBe(15);
  });

  it("returns null when the first block does not fit", () => {
    // W = 150, cap = 37; block 1 has 120 words.
    const src = [para(1, 120), para(2, 10), para(3, 10), para(4, 10)].join(
      "\n\n",
    );
    expect(renderArticleExcerpt(src)).toBeNull();
  });

  it("keeps a fenced code block with blank lines whole", () => {
    const fence = "```\nline one\n\nline two\n\nline three\n```";
    const src = [para(1, 10), fence, paras(30, 20)].join("\n\n");
    const out = renderArticleExcerpt(src)!;
    expect(out).toContain(
      "<pre><code>line one\n\nline two\n\nline three\n</code></pre>",
    );
  });

  it("renders no images, only their alt text", () => {
    const src = [
      "![shown alt](https://i.example/p.png) " + para(1, 30),
      paras(9, 40),
    ].join("\n\n");
    const out = renderArticleExcerpt(src)!;
    expect(out).not.toContain("<img");
    expect(out).toContain("shown alt");
  });

  for (const [name, p] of Object.entries(PAYLOADS)) {
    it(`${name}: the rendered excerpt stays within the cap`, () => {
      expect(visibleWords(renderArticleExcerpt(p.src))).toBeLessThanOrEqual(
        cap(p.w),
      );
    });
  }

  it("CR_ONLY: keeps the first two paragraphs", () => {
    const out = renderArticleExcerpt(PAYLOADS.CR_ONLY.src);
    expect(out).toContain("CR2MARK");
    expect(out).not.toContain("CR3MARK");
  });

  it("REF_DEFS: resolves reference links from the whole body", () => {
    const out = renderArticleExcerpt(PAYLOADS.REF_DEFS.src)!;
    expect(out).toContain('href="https://ok.example/ref"');
    expect(out).not.toContain("label0");
  });

  it("returns null for an empty body", () => {
    expect(renderArticleExcerpt("")).toBeNull();
  });
});

describe("excerptWithinCap", () => {
  it("allows 300 words and no more when the body is long", () => {
    expect(excerptWithinCap(300, 4000)).toBe(true);
    expect(excerptWithinCap(301, 4000)).toBe(false);
  });

  it("rounds 25% of the body down", () => {
    // 7 / 4 = 1.75: the cap is 1.
    expect(excerptWithinCap(1, 7)).toBe(true);
    expect(excerptWithinCap(2, 7)).toBe(false);
  });

  it("allows nothing for an empty body", () => {
    expect(excerptWithinCap(0, 0)).toBe(true);
    expect(excerptWithinCap(1, 0)).toBe(false);
  });

  it("caps at 300, not 25%, for a 2000-word body", () => {
    expect(excerptWithinCap(300, 2000)).toBe(true);
    expect(excerptWithinCap(301, 2000)).toBe(false);
    expect(excerptWithinCap(500, 2000)).toBe(false);
  });
});

describe("renderArticleExcerpt review round 2", () => {
  const tail = paras(10, 20);

  it("counts image alt text when choosing blocks (P2-1)", () => {
    // A 30-word alt, then ten 20-word paragraphs: W = 230, cap 57. The
    // image block (30) and paragraph 1 (20) fit. Not counting the alt
    // would choose 3 blocks that show 70 words, over the cap.
    const alt = Array.from({ length: 30 }, () => "alt").join(" ");
    const out = renderArticleExcerpt(
      `![${alt}](https://i.example/p.png)\n\n${tail}`,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("P1MARK");
  });

  const scriptAlt = "![a <script>alert(1)</script> b](https://i.example/p.png)";

  it("drops a script inside image alt text, full mode (P2-2)", () => {
    const html = renderArticleMarkdown(scriptAlt);
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<script");
  });

  it("drops a script inside image alt text, excerpt mode (P2-2)", () => {
    const html = renderArticleExcerpt(`${scriptAlt}\n\n${tail}`);
    expect(html).not.toBeNull();
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<script");
  });

  it("alt text is the visible text of the cleaned children, in full mode (P2-2)", () => {
    // Raw HTML inside the alt is dropped, not kept as text: the alt a reader
    // sees must match the words the excerpt counts.
    const html = renderArticleMarkdown(
      "![x <b>y</b> `z`](https://i.example/p.png)",
    );
    expect(html).toContain('alt="x y z"');
    expect(html).not.toContain("&lt;b&gt;");
  });

  it("caps the excerpt by the words of the rendered body (P2-3)", () => {
    const full = renderArticleMarkdown(TAG_HEAVY.src, { images: false });
    const total = htmlVisibleWords(full);
    expect(total).toBe(TAG_HEAVY.w);
    expect(
      htmlVisibleWords(renderArticleExcerpt(TAG_HEAVY.src)),
    ).toBeLessThanOrEqual(cap(total));
  });
});
