// scoreAnalysis (#7): weights, noise caps and thresholds are deterministic
// code on top of the Jev answers.
import { describe, expect, it } from "vitest";
import { scoreAnalysis } from "../../src/pipeline/analyze/score";
import { fakeAnalysisConfig, fakeAnswers } from "../fixtures/analysis/config";

const config = fakeAnalysisConfig();

describe("scoreAnalysis", () => {
  it("top tier on all five dims, weights adding up to 10, noise none -> 100", () => {
    const s = scoreAnalysis(fakeAnswers(config), config);
    expect(s.dims).toEqual({ sig: 10, nov: 10, cred: 10, reson: 10, act: 10 });
    expect(s.total).toBe(100);
    expect(s.prefilterPass).toBe(true);
    expect(s.selected).toBe(true);
    expect(s.contentType).toBe("report");
    expect(s.noiseKind).toBe("none");
    expect(s.category).toBe("alpha");
  });

  it("uses the expected tier from probabilities, not the score field", () => {
    // Expected tier 0.5*1 + 0.5*3 = 2 -> 5 on the 0-10 scale. The fake's
    // score field is 0.
    const s = scoreAnalysis(
      fakeAnswers(config, { dims: { sig: { "1": 0.5, "3": 0.5 } } }),
      config,
    );
    expect(s.dims.sig).toBe(5);
    // 2*5 + 2*10*4 = 90.
    expect(s.total).toBe(90);
  });

  it("caps a dimension by the noise kind: caps {sig: 4} put sig 10 at 4", () => {
    const s = scoreAnalysis(fakeAnswers(config, { noise: "hype" }), config);
    expect(s.dims.sig).toBe(4);
    expect(s.dims.nov).toBe(10);
    // 2*4 + 2*10*4 = 88.
    expect(s.total).toBe(88);
    expect(s.noiseKind).toBe("hype");
  });

  it("weights by the content type's row", () => {
    const s = scoreAnalysis(
      fakeAnswers(config, {
        contentType: "study",
        dims: { cred: { "0": 1 } },
      }),
      config,
    );
    // study weights sig 1, nov 3, cred 4, reson 1, act 1; cred is 0.
    expect(s.total).toBe(60);
    expect(s.contentType).toBe("study");
  });

  it("relevant 0.29 under a 0.3 threshold: prefilter fails, not selected", () => {
    const s = scoreAnalysis(fakeAnswers(config, { relevant: 0.29 }), config);
    expect(s.prefilterRelevant).toBe(0.29);
    expect(s.prefilterPass).toBe(false);
    expect(s.selected).toBe(false);
    // The score itself is still computed.
    expect(s.total).toBe(100);
  });

  it("the prefilter reads the relevant probability, not the choice", () => {
    // choice is off_topic (relevant < 0.5) but 0.3 meets the threshold.
    const answers = fakeAnswers(config, { relevant: 0.3 });
    expect(answers.prefilter.choice).toBe("off_topic");
    expect(scoreAnalysis(answers, config).prefilterPass).toBe(true);
  });

  it("selects at the select threshold, not below it", () => {
    // Every dim at expected tier 2.4 -> 6 -> total 60 = select.
    const six = { "2": 0.6, "3": 0.4 };
    const at = scoreAnalysis(
      fakeAnswers(config, {
        dims: { sig: six, nov: six, cred: six, reson: six, act: six },
      }),
      config,
    );
    expect(at.total).toBe(60);
    expect(at.selected).toBe(true);
    const below = scoreAnalysis(
      fakeAnswers(config, {
        dims: { sig: six, nov: six, cred: six, reson: six, act: { "2": 1 } },
      }),
      config,
    );
    expect(below.total).toBe(58);
    expect(below.selected).toBe(false);
  });

  it("rejects a content type the config does not have", () => {
    expect(() =>
      scoreAnalysis(fakeAnswers(config, { contentType: "other" }), config),
    ).toThrow(/content type/);
  });
});
