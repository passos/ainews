import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AudienceExplainCard } from "../src/components/artifacts/AudienceExplainCard";
import { PaperDecoderCard } from "../src/components/artifacts/PaperDecoderCard";
import { StoryBriefCard } from "../src/components/artifacts/StoryBriefCard";
import type {
  AudienceExplain,
  ResearchPaperDecoder,
  StoryBrief,
} from "../src/lib/artifacts/types";

describe("StoryBriefCard", () => {
  it("renders the 4 key sections", () => {
    const brief: StoryBrief = {
      whatHappened: "What happened text",
      whatIsNew: "What is new text",
      whatEvidenceExists: "Evidence text",
      whatToWatchNext: "Watch next text",
    };

    const html = renderToStaticMarkup(createElement(StoryBriefCard, { brief }));
    expect(html).toContain("AI Story Brief");
    expect(html).toContain("What Happened");
    expect(html).toContain("What happened text");
    expect(html).toContain("What Is New");
    expect(html).toContain("What is new text");
    expect(html).toContain("What Evidence Exists");
    expect(html).toContain("Evidence text");
    expect(html).toContain("What To Watch Next");
    expect(html).toContain("Watch next text");
  });
});

describe("AudienceExplainCard", () => {
  it("renders audience tabs and explainer content", () => {
    const student: AudienceExplain = {
      audience: "student",
      overview: "Student overview text",
      keyPoints: ["Point A", "Point B"],
      implications: ["Takeaway 1"],
      glossary: [{ term: "Term 1", definition: "Def 1" }],
    };

    const html = renderToStaticMarkup(
      createElement(AudienceExplainCard, {
        explanations: { student },
      }),
    );

    expect(html).toContain("News-to-Learning");
    expect(html).toContain("Student overview text");
    expect(html).toContain("Point A");
    expect(html).toContain("Point B");
    expect(html).toContain("Takeaway 1");
    expect(html).toContain("Term 1");
    expect(html).toContain("Def 1");
  });

  it("selects initialAudience when provided in props", () => {
    const student: AudienceExplain = {
      audience: "student",
      overview: "Student overview text",
      keyPoints: ["Point A"],
      implications: ["Takeaway 1"],
      glossary: [],
    };
    const professional: AudienceExplain = {
      audience: "professional",
      overview: "Professional overview text",
      keyPoints: ["Pro point"],
      implications: ["Pro implication"],
      glossary: [],
    };

    const html = renderToStaticMarkup(
      createElement(AudienceExplainCard, {
        explanations: { student, professional },
        initialAudience: "professional",
      }),
    );

    expect(html).toContain("Professional overview text");
    expect(html).toContain("Pro point");
  });

  it("returns null when no explanations are available", () => {
    const html = renderToStaticMarkup(
      createElement(AudienceExplainCard, {
        explanations: {},
      }),
    );
    expect(html).toBe("");
  });
});

describe("PaperDecoderCard", () => {
  it("renders the 5 research paper sections", () => {
    const decoder: ResearchPaperDecoder = {
      hypothesis: "Core hypothesis",
      method: "Experimental methodology",
      findings: "Benchmark numbers",
      limitations: "Identified limitations",
      applications: "Downstream uses",
    };

    const html = renderToStaticMarkup(
      createElement(PaperDecoderCard, { decoder }),
    );
    expect(html).toContain("Research Paper Decoder");
    expect(html).toContain("1. Hypothesis &amp; Problem");
    expect(html).toContain("Core hypothesis");
    expect(html).toContain("2. Methodology &amp; Architecture");
    expect(html).toContain("Experimental methodology");
    expect(html).toContain("3. Empirical Findings &amp; Benchmarks");
    expect(html).toContain("Benchmark numbers");
    expect(html).toContain("4. Caveats &amp; Limitations");
    expect(html).toContain("Identified limitations");
    expect(html).toContain("5. Downstream Applications");
    expect(html).toContain("Downstream uses");
  });
});
