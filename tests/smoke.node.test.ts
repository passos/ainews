import { expect, it } from "vitest";
import { SAFETY_FLAGS } from "../src/lib/flags";

// Placeholder for the `node` project until #4 adds tests/architecture.test.ts.
it("runs in node", () => {
  expect(typeof process.versions.node).toBe("string");
  expect(SAFETY_FLAGS).toHaveLength(7);
});
