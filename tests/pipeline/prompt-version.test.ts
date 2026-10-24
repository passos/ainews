// promptVersion follows the write request (#7): a change to the write prompt
// in prompts.ts gives a new version without a manual bump. The prompt is a
// module constant, so the test swaps the module.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAnalysisConfig } from "../../src/pipeline/analyze/config";
import { SEED_INDUSTRIES } from "../../src/server/db/seed/industries";
import { fakeAnalysisConfig } from "../fixtures/analysis/config";

const PROMPTS = "../../src/pipeline/analyze/prompts";
const QUESTIONS = "../../src/pipeline/analyze/questions";

afterEach(() => {
  vi.doUnmock(PROMPTS);
  vi.resetModules();
});

describe("promptVersion", () => {
  it("changes when the write request changes", async () => {
    const config = fakeAnalysisConfig();
    const before = await (await import(QUESTIONS)).promptVersion(config);
    vi.resetModules();
    vi.doMock(PROMPTS, async (importOriginal) => {
      const real =
        await importOriginal<
          typeof import("../../src/pipeline/analyze/prompts")
        >();
      return {
        ...real,
        buildWriteRequest: (
          ...args: Parameters<typeof real.buildWriteRequest>
        ) => {
          const request = real.buildWriteRequest(...args);
          return { ...request, system: `${request.system}\nChanged.` };
        },
      };
    });
    const after = await (await import(QUESTIONS)).promptVersion(config);
    expect(after).toMatch(/^[0-9a-f]{16}$/);
    expect(after).not.toBe(before);
  });

  it("changes when the write thinking config changes", async () => {
    const config = fakeAnalysisConfig();
    const before = await (await import(QUESTIONS)).promptVersion(config);
    vi.resetModules();
    vi.doMock(PROMPTS, async (importOriginal) => {
      const real =
        await importOriginal<
          typeof import("../../src/pipeline/analyze/prompts")
        >();
      return {
        ...real,
        buildWriteRequest: (
          ...args: Parameters<typeof real.buildWriteRequest>
        ) => ({
          ...real.buildWriteRequest(...args),
          thinkingConfig: { thinkingBudget: 1 },
        }),
      };
    });
    const after = await (await import(QUESTIONS)).promptVersion(config);
    expect(after).not.toBe(before);
  });

  // #55 widened the write output limits in code only: the request, and so
  // the version of every seeded section, must stay as it was on 2026-10-23.
  it("the four seeded sections keep their production versions", async () => {
    const { promptVersion } = await import(QUESTIONS);
    const versions: Record<string, string> = {};
    for (const industry of SEED_INDUSTRIES) {
      // The same path as analyzeArticle: industries.config -> parse.
      const config = parseAnalysisConfig(
        JSON.stringify({ analysis: industry.analysis }),
      );
      versions[industry.slug] = await promptVersion(config);
    }
    expect(versions).toEqual({
      technology: "19a2ecccdef7691b",
      education: "1756c78f56655a3d",
      industry: "4d1f4231ee928b63",
      finance: "a133ab041d5a1f2e",
    });
  });
});
