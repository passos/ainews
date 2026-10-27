import { describe, expect, it } from "vitest";
import { learningMaterialSchema } from "../../src/lib/artifacts/types";
import { parseLearningMaterialOutput } from "../../src/pipeline/artifacts/prompts";

// Production shapes (#126): the model often writes an activity as an object
// instead of a string. All keys seen in the ledger are listed here.
const base = {
  audience: "student",
  conceptExplainer: "Explaining attention mechanism simply.",
  glossary: [{ term: "Attention", definition: "Focusing on words." }],
  quiz: [
    {
      question: "What does attention do?",
      options: ["Focuses on tokens", "Shuts down GPU"],
      answerIndex: 0,
      explanation: "It weights relevant input tokens.",
    },
  ],
  discussionQuestions: ["Why is context length important?"],
};

function parseActivities(activities: unknown[]) {
  return parseLearningMaterialOutput(JSON.stringify({ ...base, activities }));
}

describe("learning_material activities tolerate object elements (#126)", () => {
  it.each([
    [
      "{title, description}",
      { title: "Simulation", description: "Students build a model." },
      "Simulation: Students build a model.",
    ],
    [
      "{title, instructions}",
      { title: "Debate", instructions: "Split into two teams." },
      "Debate: Split into two teams.",
    ],
    [
      "{name, description}",
      { name: "Role play", description: "Act out the roles." },
      "Role play: Act out the roles.",
    ],
    [
      "{activity, description}",
      { activity: "Sorting", description: "Sort the cards." },
      "Sorting: Sort the cards.",
    ],
    [
      "{activityName, description}",
      { activityName: "Mapping", description: "Draw the map." },
      "Mapping: Draw the map.",
    ],
  ])("accepts %s and joins the values", (_label, element, joined) => {
    const res = parseActivities([element]);
    expect(res).not.toBeNull();
    expect(res?.activities).toEqual([joined]);
  });

  it("keeps string elements as they are and mixes with objects in order", () => {
    const res = parseActivities([
      "Plain string.",
      { title: "T", description: "D" },
    ]);
    expect(res?.activities).toEqual(["Plain string.", "T: D"]);
  });

  it("joins in key order, skipping empty values", () => {
    const res = parseActivities([
      { description: "First", title: "", extra: "Last" },
    ]);
    expect(res?.activities).toEqual(["First: Last"]);
  });

  it("still rejects an element with a number value", () => {
    expect(parseActivities([{ title: "T", minutes: 15 }])).toBeNull();
  });

  it("still rejects an element with a nested object value", () => {
    expect(
      parseActivities([{ title: "T", detail: { step: "one" } }]),
    ).toBeNull();
  });

  it("still rejects arrays, null, numbers, empty objects and all-empty objects", () => {
    for (const bad of [
      ["a", "b"],
      null,
      7,
      {},
      { title: "", description: "" },
    ]) {
      expect(parseActivities([bad]), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects a nested-object element with path activities.0 and code invalid_type", () => {
    const res = learningMaterialSchema.safeParse({
      ...base,
      activities: [{ title: "T", detail: { step: "one" } }],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.map((i) => ({ path: i.path, code: i.code })),
      ).toEqual([{ path: ["activities", 0], code: "invalid_type" }]);
    }
  });

  it("rejects String objects and class instances without a JSON round trip", () => {
    class Activity {
      title = "Debate";
      description = "Split into two teams.";
    }
    for (const bad of [new String("AB"), new Activity()]) {
      const res = learningMaterialSchema.safeParse({
        ...base,
        activities: [bad],
      });
      expect(res.success, Object.prototype.toString.call(bad)).toBe(false);
    }
  });
});
