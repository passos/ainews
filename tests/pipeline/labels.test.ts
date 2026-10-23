// Evidence labels (#7): one case per option of every label, generated from
// labels.ts, so a new option cannot go without a fixture.
import { describe, expect, it } from "vitest";
import {
  LABEL_KEYS,
  LABELS,
  labelValue,
  UNCERTAIN,
} from "../../src/pipeline/analyze/labels";
import { choice } from "../fixtures/analysis/config";

describe.each(LABEL_KEYS)("label %s", (key) => {
  it.each(Object.keys(LABELS[key].options))(
    "%s: confidence 0.9 stores the option, 0.4 stores uncertain",
    (option) => {
      expect(labelValue(key, choice(option, 0.9))).toBe(option);
      expect(labelValue(key, choice(option, 0.4))).toBe(UNCERTAIN);
    },
  );
});

describe("labelValue", () => {
  it("stores confidence 0.5 as the option (the bound is inclusive)", () => {
    expect(labelValue("claim_mode", choice("fact", 0.5))).toBe("fact");
  });

  it("stores an option the label does not have as uncertain", () => {
    expect(labelValue("claim_mode", choice("live", 0.9))).toBe(UNCERTAIN);
  });

  it("every option has a description", () => {
    for (const key of LABEL_KEYS) {
      expect(LABELS[key].instructions).not.toBe("");
      for (const text of Object.values(LABELS[key].options)) {
        expect(text.trim()).not.toBe("");
      }
    }
  });
});
