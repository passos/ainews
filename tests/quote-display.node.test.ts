import { describe, expect, it } from "vitest";
import { stripMarkdownLinks } from "../src/lib/quote-display";

describe("stripMarkdownLinks", () => {
  it("keeps the text of a link and drops the url", () => {
    expect(stripMarkdownLinks("[a](http://x)")).toBe("a");
    expect(
      stripMarkdownLinks("See [the report](https://x.example/r) now"),
    ).toBe("See the report now");
  });

  it("handles several links in one quote", () => {
    expect(stripMarkdownLinks("[a](http://x) and [b](http://y)!")).toBe(
      "a and b!",
    );
  });

  it("leaves text without a link unchanged", () => {
    for (const s of [
      "plain words",
      "a [bracket] here",
      "(paren) only",
      "[no url] (space between)",
      "[unclosed](http://x",
      "[[nested]](http://x)",
      "![img](http://x)",
      "",
    ]) {
      expect(stripMarkdownLinks(s)).toBe(s);
    }
  });

  it("handles balanced parentheses and a title in the url part", () => {
    expect(stripMarkdownLinks("[a](http://x/wiki/Foo_(bar)) end")).toBe(
      "a end",
    );
    expect(stripMarkdownLinks('[a](http://x "title") end')).toBe("a end");
  });

  it("stays fast on adversarial input", () => {
    const start = Date.now();
    stripMarkdownLinks("[a](".repeat(50_000));
    stripMarkdownLinks("[".repeat(100_000));
    stripMarkdownLinks("[a]".repeat(50_000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
