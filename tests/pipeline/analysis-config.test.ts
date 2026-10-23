// AnalysisConfig (#7): the shape #8 must fill in industries.config.analysis.
import { describe, expect, it } from "vitest";
import {
  analysisConfigSchema,
  parseAnalysisConfig,
} from "../../src/pipeline/analyze/config";
import { fakeAnalysisConfig } from "../fixtures/analysis/config";

const ok = fakeAnalysisConfig();
const rejects = (value: unknown) =>
  expect(analysisConfigSchema.safeParse(value).success).toBe(false);

describe("AnalysisConfig", () => {
  it("accepts the test config", () => {
    expect(analysisConfigSchema.parse(ok)).toEqual(ok);
  });

  it("rejects weights that add up to 9", () => {
    rejects({
      ...ok,
      contentTypes: {
        report: {
          description: "A report.",
          weights: { sig: 1, nov: 2, cred: 2, reson: 2, act: 2 },
        },
      },
    });
  });

  it("rejects fractional weights that add up to 10", () => {
    rejects({
      ...ok,
      contentTypes: {
        report: {
          description: "A report.",
          weights: { sig: 1.5, nov: 2.5, cred: 2, reson: 2, act: 2 },
        },
      },
    });
  });

  it("rejects a dimension with 4 tiers", () => {
    rejects({
      ...ok,
      dimensions: { ...ok.dimensions, cred: ["a", "b", "c", "d"] },
    });
  });

  it('rejects noise without "none"', () => {
    rejects({ ...ok, noise: { hype: ok.noise.hype } });
  });

  it("rejects a cap outside 0-10", () => {
    rejects({
      ...ok,
      noise: { ...ok.noise, hype: { description: "Hype.", caps: { sig: 11 } } },
    });
  });

  it("rejects fewer than 2 categories", () => {
    rejects({ ...ok, categories: { alpha: "Category alpha." } });
  });

  it("rejects an unknown or repeated label", () => {
    rejects({ ...ok, labels: ["publication_status", "made_up"] });
    rejects({ ...ok, labels: ["claim_mode", "claim_mode"] });
  });

  it("rejects thresholds out of range", () => {
    rejects({
      ...ok,
      thresholds: { prefilterMinRelevant: 1.2, select: 60 },
    });
    rejects({
      ...ok,
      thresholds: { prefilterMinRelevant: 0.3, select: 101 },
    });
  });

  it("rejects unknown keys", () => {
    rejects({ ...ok, extra: 1 });
  });
});

describe("parseAnalysisConfig", () => {
  it("reads `analysis` from the industries.config JSON", () => {
    expect(parseAnalysisConfig(JSON.stringify({ analysis: ok }))).toEqual(ok);
  });

  it("returns null for a missing, invalid or unreadable config", () => {
    expect(parseAnalysisConfig("{}")).toBeNull();
    expect(parseAnalysisConfig("not json")).toBeNull();
    expect(parseAnalysisConfig("null")).toBeNull();
    expect(
      parseAnalysisConfig(
        JSON.stringify({ analysis: { ...ok, noise: { hype: ok.noise.hype } } }),
      ),
    ).toBeNull();
  });
});
