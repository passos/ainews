// Runs in the `workers` project, so it also shows markdown-it works in workerd.
import { describe, expect, it } from "vitest";
import {
  excerptMarkdown,
  renderArticleMarkdown,
  renderMarkdown,
} from "../src/lib/markdown";

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

describe("excerptMarkdown", () => {
  it("keeps whole blocks up to 25% of the words", () => {
    // W = 500, cap = 125: two 50-word blocks.
    const out = excerptMarkdown(paras(10, 50));
    expect(kept(out)).toBe(2);
    expect(out).not.toContain("P3MARK");
  });

  it("uses 25% when it is below 300 words", () => {
    // W = 600, cap = 150.
    expect(kept(excerptMarkdown(paras(30, 20)))).toBe(7);
  });

  it("never keeps more than 300 words", () => {
    // W = 2000: 25% is 500, the 300-word cap wins. (At W = 1200 both
    // limits are 300, so that size cannot tell them apart.)
    expect(kept(excerptMarkdown(paras(100, 20)))).toBe(15);
  });

  it("returns null when the first block does not fit", () => {
    // W = 150, cap = 37; block 1 has 120 words.
    const src = [para(1, 120), para(2, 10), para(3, 10), para(4, 10)].join(
      "\n\n",
    );
    expect(excerptMarkdown(src)).toBeNull();
  });

  it("does not stop inside a fenced code block with blank lines", () => {
    const fence = "```\nline one\n\nline two\n\nline three\n```";
    const src = [para(1, 10), fence, paras(30, 20)].join("\n\n");
    const out = excerptMarkdown(src)!;
    expect(out).not.toBeNull();
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it("does not count image alt text", () => {
    // Block 1 is an image with a 200-word alt. W counts only the 4 x 25
    // paragraph words (100, cap 25), so block 1 (0 words) and block 2 fit.
    const alt = Array.from({ length: 200 }, () => "alt").join(" ");
    const src = [`![${alt}](https://i.example/p.png)`, paras(4, 25)].join(
      "\n\n",
    );
    expect(kept(excerptMarkdown(src))).toBe(1);
  });

  it("returns null for an empty body", () => {
    expect(excerptMarkdown("")).toBeNull();
  });
});
