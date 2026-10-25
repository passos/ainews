import { describe, expect, it } from "vitest";
import {
  evaluateRealityCheck,
  type RealityCheckCitation,
} from "../../src/pipeline/evidence/verify";

describe("tests/pipeline/reality-check.test.ts", () => {
  it("returns unspecified when no citations are verified", () => {
    const citations: RealityCheckCitation[] = [
      { verified: false, sourceRole: "vendor", stance: "support" },
      { verified: false, sourceRole: "independent", stance: "support" },
    ];
    expect(evaluateRealityCheck(citations)).toBe("unspecified");
  });

  it("returns vendor_only when all supporting citations are from vendor and none independent", () => {
    const citations: RealityCheckCitation[] = [
      { verified: true, sourceRole: "vendor", stance: "support" },
      { verified: false, sourceRole: "independent", stance: "dispute" }, // unverified doesn't count
    ];
    expect(evaluateRealityCheck(citations)).toBe("vendor_only");
  });

  it("returns independent_verified when at least one independent citation supports and no independent dispute", () => {
    const citations: RealityCheckCitation[] = [
      { verified: true, sourceRole: "vendor", stance: "support" },
      { verified: true, sourceRole: "independent", stance: "support" },
    ];
    expect(evaluateRealityCheck(citations)).toBe("independent_verified");
  });

  it("returns independent_disputed when any verified independent citation disputes, taking priority over vendor claims", () => {
    const citations: RealityCheckCitation[] = [
      { verified: true, sourceRole: "vendor", stance: "support" },
      { verified: true, sourceRole: "independent", stance: "support" },
      { verified: true, sourceRole: "independent", stance: "dispute" },
    ];
    expect(evaluateRealityCheck(citations)).toBe("independent_disputed");
  });

  it("vendor dispute without independent dispute does not yield independent_disputed", () => {
    const citations: RealityCheckCitation[] = [
      { verified: true, sourceRole: "vendor", stance: "dispute" },
    ];
    expect(evaluateRealityCheck(citations)).toBe("unspecified");
  });
});
