import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoryBriefCard } from "../src/components/artifacts/StoryBriefCard";
import { InspectEvidencePanel } from "../src/components/evidence/InspectEvidencePanel";
import {
  originalFragmentHref,
  textFragmentHref,
} from "../src/lib/text-fragment";
import type { StoryBrief } from "../src/lib/artifacts/types";
import type { ClaimView, EventEvidenceView } from "../src/lib/evidence/types";
import type { ArtifactSourceView } from "../src/server/publication/events";

const SOURCES: ArtifactSourceView[] = [
  { id: 1, title: "Source article", publishedAt: 1000, fetchedAt: 2000 },
];

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
      realityCheck: "vendor_only",
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
          sourceRole: "vendor",
          inArticle: true,
        },
      ],
    };

    const claim2: ClaimView = {
      id: 102,
      claimText: "Analyst predicts commercial availability by late 2027",
      claimType: "prediction",
      consensusStatus: "disputed",
      primarySourcePreferred: false,
      realityCheck: "independent_disputed",
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
          sourceRole: "independent",
          inArticle: false,
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
    expect(html).toContain(">Supported · model assessment<");
    expect(html).toContain("Model assessment: vendor claim only");
    expect(html).toContain("Vendor · model assessment");
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
    expect(html).toContain(">Disputed · model assessment<");
    expect(html).toContain("Model assessment: disputed by independent source");
    expect(html).toContain(
      "Analyst predicts commercial availability by late 2027",
    );
  });
});

describe("InspectEvidencePanel quote links", () => {
  const claim = (inArticle: boolean): ClaimView => ({
    id: 1,
    claimText: "A claim",
    claimType: "fact",
    consensusStatus: "verified",
    primarySourcePreferred: false,
    realityCheck: "unspecified",
    status: "published",
    evidence: [
      {
        id: 9,
        articleId: 42,
        articleTitle: "Cited article",
        articleUrl: "https://news.example/cited",
        sourceName: "Wire",
        sourceDomain: "news.example",
        bodySha: "sha",
        stance: "support",
        quote: "Quoted words here",
        startOffset: 0,
        endOffset: 17,
        verified: true,
        isPrimarySource: false,
        sourceRole: "independent",
        inArticle,
      },
    ],
  });
  const render = (inArticle: boolean) =>
    renderToStaticMarkup(
      createElement(InspectEvidencePanel, {
        evidence: { eventId: 1, claims: [claim(inArticle)] },
      }),
    );

  it("links a quote in the shown range to the reader page with a text fragment", () => {
    const html = render(true);
    expect(html).toContain('href="/a/42#:~:text=Quoted%20words%20here"');
    expect(html).toContain('href="https://news.example/cited"');
    expect(html).not.toContain("Quote is in the full article");
  });

  it("links a quote outside the shown range to the original with a text fragment", () => {
    const html = render(false);
    expect(html).not.toContain('href="/a/42');
    expect(html).toContain(
      'href="https://news.example/cited#:~:text=Quoted%20words%20here"',
    );
    expect(html).toContain("Quote is in the full article at Wire");
    expect(html).toContain('href="https://news.example/cited"');
  });
});

describe("InspectEvidencePanel model-output labels", () => {
  const claim = (
    realityCheck: ClaimView["realityCheck"],
    sourceRole: "vendor" | "independent",
    quote = "Quoted words here",
  ): ClaimView => ({
    id: 1,
    claimText: "A claim",
    claimType: "fact",
    consensusStatus: "verified",
    primarySourcePreferred: false,
    realityCheck,
    status: "published",
    evidence: [
      {
        id: 9,
        articleId: 42,
        articleTitle: "Cited article",
        articleUrl: "https://news.example/cited",
        sourceName: "Wire",
        sourceDomain: "news.example",
        bodySha: "sha",
        stance: "support",
        quote,
        startOffset: 0,
        endOffset: 17,
        verified: true,
        isPrimarySource: false,
        sourceRole,
        inArticle: true,
      },
    ],
  });
  const render = (c: ClaimView) =>
    renderToStaticMarkup(
      createElement(InspectEvidencePanel, {
        evidence: { eventId: 1, claims: [c] },
      }),
    );

  it("labels the reality check as a model assessment", () => {
    expect(render(claim("vendor_only", "vendor"))).toContain(
      "Model assessment: vendor claim only",
    );
    expect(render(claim("independent_verified", "independent"))).toContain(
      "Model assessment: independent support",
    );
    expect(render(claim("independent_disputed", "independent"))).toContain(
      "Model assessment: disputed by independent source",
    );
    expect(render(claim("unspecified", "independent"))).not.toContain(
      "Model assessment: ",
    );
  });

  it("labels the citation source role as a model assessment", () => {
    expect(render(claim("unspecified", "vendor"))).toContain(
      "Vendor · model assessment",
    );
    expect(render(claim("unspecified", "independent"))).toContain(
      "Independent · model assessment",
    );
  });

  it("labels the consensus badge as a model assessment", () => {
    const withStatus = (status: ClaimView["consensusStatus"]) =>
      render({
        ...claim("unspecified", "independent"),
        consensusStatus: status,
      });
    const verified = withStatus("verified");
    expect(verified).toContain(">Supported · model assessment<");
    expect(verified).not.toContain(">Verified<");
    expect(withStatus("disputed")).toContain(">Disputed · model assessment<");
    const unverified = withStatus("unverified");
    expect(unverified).toContain(">Unverified<");
    expect(unverified).not.toContain("Unverified ·");
  });

  it("shows markdown links in a quote as plain text but links from the raw quote", () => {
    const raw = "See [the report](http://x.example/wiki/A_(b)) now";
    const html = render(claim("unspecified", "independent", raw));
    expect(html).toContain("See the report now");
    expect(html).not.toContain("x.example/wiki");
    expect(html).not.toContain("](");
    const expected = textFragmentHref(42, raw);
    expect(expected).not.toBe(textFragmentHref(42, "See the report now"));
    expect(html).toContain(`href="${expected}"`);
  });

  it("uses the raw quote for the original link too", () => {
    const raw = "See [the report](http://x.example/wiki/A_(b)) now";
    const c = claim("unspecified", "independent", raw);
    c.evidence[0].inArticle = false;
    const html = render(c);
    const expected = originalFragmentHref("https://news.example/cited", raw);
    expect(expected).not.toBe(
      originalFragmentHref("https://news.example/cited", "See the report now"),
    );
    expect(html).toContain(`href="${expected}"`);
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
        sources: SOURCES,
      }),
    );

    expect(html).toContain("AI Story Brief");
    expect(html).toContain("What Evidence Exists");
    expect(html).toContain("Traced to primary lab report");
    expect(html).toContain("Verified high-throughput architecture benchmarked");
  });
});
