// ARTIFACT_REGISTRY isEligible (#104): reader artifacts and section products
// carry no score gate (round 6). Finance products and the cross-section
// Industry report keep theirs.
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_REGISTRY,
  type ArticleMetadata,
  type ArtifactEligibilityContext,
} from "../../src/pipeline/artifacts/registry";

function article(over: Partial<ArticleMetadata> = {}): ArticleMetadata {
  return {
    id: 1,
    sourceDomain: "example.com",
    contentType: "product_launch",
    evidenceTags: [],
    ...over,
  };
}

function ctx(
  over: Partial<ArtifactEligibilityContext> = {},
): ArtifactEligibilityContext {
  return {
    selectThreshold: 60,
    deepThreshold: 90,
    eventScore: 0,
    articles: [article()],
    industrySlug: "technology",
    industryName: "Technology",
    ...over,
  };
}

const eligible = (
  type: keyof typeof ARTIFACT_REGISTRY,
  over: Partial<ArtifactEligibilityContext> = {},
) => ARTIFACT_REGISTRY[type].isEligible(ctx(over));

describe("artifact eligibility", () => {
  it("reader artifacts ignore the event score (round 6, #104)", () => {
    for (const type of ["audience_explain", "learning_material"] as const) {
      for (const eventScore of [0, 100]) {
        expect(
          eligible(type, { industrySlug: "technology", eventScore }),
          `${type} @ ${eventScore}`,
        ).toBe(true);
      }
    }
  });

  it("research_paper_decoder needs a paper, not a score", () => {
    expect(
      eligible("research_paper_decoder", {
        eventScore: 0,
        articles: [article({ sourceDomain: "arxiv.org" })],
      }),
    ).toBe(true);
    expect(eligible("research_paper_decoder", { eventScore: 100 })).toBe(false);
  });

  it("section products ignore the score; section and content rules stay", () => {
    const education = {
      industrySlug: "education",
      eventScore: 0,
      articles: [article({ contentType: "policy_change" })],
    };
    expect(eligible("policy_impact_explorer", education)).toBe(true);
    expect(
      eligible("policy_impact_explorer", {
        ...education,
        industrySlug: "technology",
      }),
    ).toBe(false);

    const industry = {
      industrySlug: "industry",
      eventScore: 0,
      articles: [article({ contentType: "market_trend" })],
    };
    expect(eligible("skills_career_trends", industry)).toBe(true);
    expect(eligible("industry_impact_report", industry)).toBe(true);
  });

  it("industry_impact_report outside Industry keeps the deep gate", () => {
    const technology = {
      industrySlug: "technology",
      articles: [article({ contentType: "tool_or_product" })],
    };
    expect(
      eligible("industry_impact_report", { ...technology, eventScore: 89 }),
    ).toBe(false);
    expect(
      eligible("industry_impact_report", { ...technology, eventScore: 90 }),
    ).toBe(true);
  });

  it("Finance products keep their score rule", () => {
    const finance = { industrySlug: "finance" };
    expect(
      eligible("finance_concept_explainer", { ...finance, eventScore: 59 }),
    ).toBe(false);
    expect(
      eligible("finance_concept_explainer", { ...finance, eventScore: 60 }),
    ).toBe(true);
  });

  it("no articles, no artifact", () => {
    for (const type of [
      "story_brief",
      "audience_explain",
      "learning_material",
    ] as const) {
      expect(eligible(type, { articles: [], eventScore: 100 }), type).toBe(
        false,
      );
    }
  });
});
