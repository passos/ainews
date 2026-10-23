// Runs in the `workers` project, so it also shows markdown-it works in workerd.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

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
