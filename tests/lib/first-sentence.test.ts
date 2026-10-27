import { describe, expect, it } from "vitest";
import { firstSentence } from "../../src/lib/first-sentence";

describe("firstSentence", () => {
  it("returns only the first sentence and keeps its period", () => {
    expect(firstSentence("An audit found flaws. Nobody was hurt. End.")).toBe(
      "An audit found flaws.",
    );
  });

  it("treats text without a period and space as one sentence", () => {
    expect(firstSentence("No full stop here")).toBe("No full stop here");
    expect(firstSentence("Ends with a period.")).toBe("Ends with a period.");
  });

  it("trims the input", () => {
    expect(firstSentence("  One. Two.  ")).toBe("One.");
  });

  it("does not cut inside a number", () => {
    expect(firstSentence("Prices rose 3.5 percent in May. More later.")).toBe(
      "Prices rose 3.5 percent in May.",
    );
  });

  it("returns an empty string for empty or blank input", () => {
    expect(firstSentence("")).toBe("");
    expect(firstSentence("  \n ")).toBe("");
  });

  it("caps a long sentence at max characters with an ellipsis", () => {
    const long = `${"word ".repeat(100)}end.`;
    const out = firstSentence(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(220);
    // Cut at a word boundary: no half word before the ellipsis.
    expect(out.slice(0, -1)).toMatch(/word$/);
  });

  it("honours a custom max and cuts mid-word when there is no space", () => {
    const out = firstSentence("x".repeat(50), 10);
    expect(out).toBe(`${"x".repeat(9)}…`);
    expect(firstSentence("short one", 220)).toBe("short one");
  });
});
