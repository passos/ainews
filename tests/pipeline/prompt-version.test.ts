// promptVersion follows the write request (#7): a change to the write prompt
// in prompts.ts gives a new version without a manual bump. The prompt is a
// module constant, so the test swaps the module.
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
