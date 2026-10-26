// CPU bound of the article renderer on a hostile 200 KB body (#86 review r3).
// In the node project: workerd does not advance the clock during pure CPU
// work, so a time limit cannot be measured there.
import { describe, expect, it } from "vitest";
import {
  renderArticleExcerpt,
  renderArticleMarkdown,
} from "../../src/lib/markdown";

const HOSTILE = (
  "word ".repeat(20) +
  "\n\n<div>\n" +
  "<script ".repeat(25000)
).slice(0, 200_000);

const elapsed = (fn: () => unknown) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

describe("article renderer CPU on unclosed <script tags", () => {
  it("renderArticleMarkdown takes under 500 ms", { timeout: 60_000 }, () => {
    expect(elapsed(() => renderArticleMarkdown(HOSTILE))).toBeLessThan(500);
  });

  it("renderArticleExcerpt takes under 500 ms", { timeout: 60_000 }, () => {
    expect(elapsed(() => renderArticleExcerpt(HOSTILE))).toBeLessThan(500);
  });
});
