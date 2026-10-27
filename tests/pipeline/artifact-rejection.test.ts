import { describe, expect, it } from "vitest";
import { storyBriefSchema } from "../../src/lib/artifacts/types";
import { diagnoseArtifactRejection } from "../../src/pipeline/artifacts/prompts";
import { ARTIFACT_REGISTRY } from "../../src/pipeline/artifacts/registry";

const BRIEF = {
  whatHappened: "x",
  whatIsNew: "x",
  whatEvidenceExists: "x",
  whatToWatchNext: "x",
};

describe("diagnoseArtifactRejection (#126)", () => {
  it("a: reports path and code of an out-of-range answerIndex", () => {
    const raw = JSON.stringify({
      audience: "student",
      conceptExplainer: "c",
      glossary: [],
      quiz: [
        {
          question: "q",
          options: ["a", "b"],
          answerIndex: 2,
          explanation: "e",
        },
      ],
      discussionQuestions: [],
      activities: [],
    });
    expect(
      diagnoseArtifactRejection(
        raw,
        ARTIFACT_REGISTRY.learning_material.diagnosisSchema,
      ),
    ).toEqual([{ path: ["quiz", 0, "answerIndex"], code: "custom" }]);
  });

  it("b: strips the fence and never returns model text", () => {
    const raw =
      "```json\n" +
      JSON.stringify({ ...BRIEF, SENTINEL_K_7f3a: "v" }) +
      "\n```";
    const result = diagnoseArtifactRejection(raw, storyBriefSchema);
    expect(result).toEqual([{ path: [], code: "unrecognized_keys" }]);
    expect(JSON.stringify(result)).not.toContain("7f3a");
  });

  it("c: earnings_decoder has no schema, so valid JSON is unavailable and bad JSON is invalid_json", () => {
    expect(ARTIFACT_REGISTRY.earnings_decoder.diagnosisSchema).toBeNull();
    expect(diagnoseArtifactRejection("{}", null)).toBe("unavailable");
    expect(diagnoseArtifactRejection("SENTINEL_RAW_7f3a{{{", null)).toBe(
      "invalid_json",
    );
  });

  it("d: a valid story brief gives an empty list", () => {
    expect(
      diagnoseArtifactRejection(JSON.stringify(BRIEF), storyBriefSchema),
    ).toEqual([]);
  });

  it("e: every registry entry but earnings_decoder carries a schema", () => {
    for (const [type, def] of Object.entries(ARTIFACT_REGISTRY)) {
      if (type === "earnings_decoder") {
        expect(def.diagnosisSchema).toBeNull();
      } else {
        expect(def.diagnosisSchema, type).not.toBeNull();
      }
    }
  });
});
