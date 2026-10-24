import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoryBriefCard } from "../src/components/artifacts/StoryBriefCard";
import { InspectEvidencePanel } from "../src/components/evidence/InspectEvidencePanel";
import type { StoryBrief } from "../src/lib/artifacts/types";
import type { ClaimView, EventEvidenceView } from "../src/lib/evidence/types";

describe("InspectEvidencePanel", () => {
  it("renders null when evidence has no claims", () => {
    const emptyEvidence: EventEvidenceView = { eventId: 1, claims: [] };
    const html = renderToStaticMarkup(
      createElement(InspectEvidencePanel, { evidence: emptyEvidence }),
    );
    expect(html).toBe("");
  });

  it("renders claims with types, consensus badges, and source citations", () => {
    const claim1: ClaimView = {
      id: 101,
      claimText: "National lab deployed 500-qubit quantum processor",
      claimType: "fact",
      consensusStatus: "verified",
      primarySourcePreferred: true,
      status: "published",
      evidence: [
        {
          id: 201,
          articleId: 1,
          articleTitle: "Department of Energy Quantum Initiative",
          articleUrl: "https://energy.gov/news/quantum-processor",
          sourceName: "DOE Press",
          sourceDomain: "energy.gov",
          bodySha: "sha256_art_1",
          stance: "support",
          quote:
            "The national lab completed deployment of its 500-qubit processor ahead of schedule.",
          startOffset: 120,
          endOffset: 205,
          verified: true,
          isPrimarySource: true,
        },
      ],
    };

    const claim2: ClaimView = {
      id: 102,
      claimText: "Analyst predicts commercial availability by late 2027",
      claimType: "prediction",
      consensusStatus: "disputed",
      primarySourcePreferred: false,
      status: "published",
      evidence: [
        {
          id: 202,
          articleId: 2,
          articleTitle: "Commercial Quantum Horizons Report",
          articleUrl: "https://analysts.example.com/reports/quantum-2027",
          sourceName: "Quantum Intel",
          sourceDomain: "analysts.example.com",
          bodySha: "sha256_art_2",
          stance: "dispute",
          quote:
            "Industry analysts dispute this ambitious timeline due to cryogenic scaling roadblocks.",
          startOffset: 50,
          endOffset: 138,
          verified: true,
          isPrimarySource: false,
        },
      ],
    };

    const evidence: EventEvidenceView = {
      eventId: 1,
      claims: [claim1, claim2],
    };

    const html = renderToStaticMarkup(
      createElement(InspectEvidencePanel, { evidence }),
    );

    // Section header
    expect(html).toContain("Inspect Evidence");
    expect(html).toContain("2 claims inspected");

    // Claim 1 assertions
    expect(html).toContain("fact");
    expect(html).toContain("Verified");
    expect(html).toContain("Primary source cited");
    expect(html).toContain("National lab deployed 500-qubit quantum processor");
    expect(html).toContain("Supports");
    expect(html).toContain("★ Original source");
    expect(html).toContain("energy.gov");
    expect(html).toContain(
      "The national lab completed deployment of its 500-qubit processor ahead of schedule.",
    );

    // Claim 2 assertions
    expect(html).toContain("prediction");
    expect(html).toContain("Disputed");
    expect(html).toContain(
      "Analyst predicts commercial availability by late 2027",
    );
  });
});

describe("StoryBriefCard with verifiedClaims", () => {
  it("renders verified claims under What Evidence Exists when provided", () => {
    const brief: StoryBrief = {
      whatHappened: "Breakthrough announced",
      whatIsNew: "Novel architecture verified",
      whatEvidenceExists: "Traced to primary lab report",
      whatToWatchNext: "Next trial results in Q4",
    };

    const verifiedClaims = [
      "Verified high-throughput architecture benchmarked",
    ];

    const html = renderToStaticMarkup(
      createElement(StoryBriefCard, {
        brief,
        verifiedClaims,
      }),
    );

    expect(html).toContain("AI Story Brief");
    expect(html).toContain("What Evidence Exists");
    expect(html).toContain("Traced to primary lab report");
    expect(html).toContain("Verified high-throughput architecture benchmarked");
  });
});
