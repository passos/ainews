import { describe, expect, it } from "vitest";
import { SAFETY_FLAGS, isEnabled } from "../src/lib/flags";

describe("safety flags", () => {
  it("are all off when unset", () => {
    for (const flag of SAFETY_FLAGS) {
      expect(isEnabled({}, flag)).toBe(false);
    }
  });

  it.each(["TRUE", "1", "yes", " true", "false", ""])(
    "treat %j as off",
    (value) => {
      for (const flag of SAFETY_FLAGS) {
        expect(isEnabled({ [flag]: value }, flag)).toBe(false);
      }
    },
  );

  it('treat exactly "true" as on', () => {
    for (const flag of SAFETY_FLAGS) {
      expect(isEnabled({ [flag]: "true" }, flag)).toBe(true);
    }
  });
});
