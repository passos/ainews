// parseWriteOutput limits (#55): a summary of 601 characters made a call that
// succeeded and was billed unusable. The prompt still asks for 600 / 120;
// the schema only has room on top.
import { describe, expect, it } from "vitest";
import { parseWriteOutput } from "../../src/pipeline/analyze/prompts";

const out = (title: string, summary: string) =>
  JSON.stringify({ title, summary });

describe("parseWriteOutput limits", () => {
  it.each([600, 601, 800])("summary of %i characters is accepted", (n) => {
    expect(parseWriteOutput(out("T", "s".repeat(n)))).toEqual({
      title: "T",
      summary: "s".repeat(n),
    });
  });

  it("summary of 801 characters is rejected", () => {
    expect(parseWriteOutput(out("T", "s".repeat(801)))).toBeNull();
  });

  it.each([120, 160])("title of %i characters is accepted", (n) => {
    expect(parseWriteOutput(out("t".repeat(n), "S"))).not.toBeNull();
  });

  it("title of 161 characters is rejected", () => {
    expect(parseWriteOutput(out("t".repeat(161), "S"))).toBeNull();
  });

  it("an empty title or summary is rejected", () => {
    expect(parseWriteOutput(out("", "S"))).toBeNull();
    expect(parseWriteOutput(out("T", "  "))).toBeNull();
  });
});
