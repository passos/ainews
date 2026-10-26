import { describe, expect, it } from "vitest";
import { SITE_NAME } from "../../src/lib/site";

describe("SITE_NAME", () => {
  it("is the reader-facing site name", () => {
    expect(SITE_NAME).toBe("Daily");
  });
});
