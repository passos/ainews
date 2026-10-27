import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AudienceExplainCard } from "../src/components/artifacts/AudienceExplainCard";
import { ClassroomDiscussionCard } from "../src/components/artifacts/ClassroomDiscussionCard";
import { EducationEvidenceCard } from "../src/components/artifacts/EducationEvidenceCard";
import { FinanceConceptCard } from "../src/components/artifacts/FinanceConceptCard";
import { FinanceRealityCheckCard } from "../src/components/artifacts/FinanceRealityCheckCard";
import { LearningMaterialCard } from "../src/components/artifacts/LearningMaterialCard";
import { PaperDecoderCard } from "../src/components/artifacts/PaperDecoderCard";
import { PolicyImpactCard } from "../src/components/artifacts/PolicyImpactCard";
import { RegulationWatchCard } from "../src/components/artifacts/RegulationWatchCard";
import { SkillsCareerTrendsCard } from "../src/components/artifacts/SkillsCareerTrendsCard";
import { StoryBriefCard } from "../src/components/artifacts/StoryBriefCard";
import { IndustryImpactCard } from "../src/components/artifacts/IndustryImpactCard";
import { SupplyChainRippleCard } from "../src/components/artifacts/SupplyChainRippleCard";
import { EarningsDecoderCard } from "../src/components/artifacts/EarningsDecoderCard";
import type {
  AudienceExplain,
  ClassroomDiscussionBuilder,
  EarningsDecoder,
  EducationEvidenceChecker,
  FinanceConceptExplainer,
  FinanceRealityCheck,
  IndustryImpactReport,
  LearningMaterial,
  PolicyImpactExplorer,
  RegulationWatch,
  ResearchPaperDecoder,
  SkillsCareerTrends,
  StoryBrief,
  SupplyChainRippleMap,
  LaunchRealityCheck,
  TechnologyEvolutionTimeline,
} from "../src/lib/artifacts/types";
import { quizQuestionSchema } from "../src/lib/artifacts/types";
import { ArtifactSources } from "../src/components/artifacts/ArtifactSources";
import { formatUtc } from "../src/lib/time";
import type { ArtifactSourceView } from "../src/server/publication/events";

const PUBLISHED_AT = Date.UTC(2026, 9, 22, 2, 5);
const FETCHED_AT = Date.UTC(2026, 9, 22, 3, 40);
const SOURCES: ArtifactSourceView[] = [
  {
    id: 7,
    title: "Agent handshakes cost more than the work they start",
    publishedAt: PUBLISHED_AT,
    fetchedAt: FETCHED_AT,
  },
];

/** The three facts every artifact shows for its source articles. */
function expectSourceInfo(html: string): void {
  expect(html).toContain('href="/a/7"');
  expect(html).toContain("Agent handshakes cost more than the work they start");
  expect(html).toContain("Published");
  expect(html).toContain(formatUtc(PUBLISHED_AT));
  expect(html).toContain(`dateTime="${new Date(PUBLISHED_AT).toISOString()}"`);
  expect(html).toContain("Fetched");
  expect(html).toContain(formatUtc(FETCHED_AT));
  expect(html).toContain(`dateTime="${new Date(FETCHED_AT).toISOString()}"`);
  // 375px guards: long titles break anywhere, the two times wrap.
  expect(html).toContain("wrap-anywhere");
  expect(html).toContain("flex-wrap");
}

describe("StoryBriefCard", () => {
  it("renders the 4 key sections", () => {
    const brief: StoryBrief = {
      whatHappened: "What happened text",
      whatIsNew: "What is new text",
      whatEvidenceExists: "Evidence text",
      whatToWatchNext: "Watch next text",
    };

    const html = renderToStaticMarkup(
      createElement(StoryBriefCard, { brief, sources: SOURCES }),
    );
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
        sources: SOURCES,
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
        sources: SOURCES,
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
        sources: SOURCES,
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

describe("LearningMaterialCard", () => {
  it("renders audience tabs, concept explainer, glossary, quiz, and activities", () => {
    const student: LearningMaterial = {
      audience: "student",
      conceptExplainer: "Learning via trial, error, and feedback loops.",
      glossary: [{ term: "Reward Function", definition: "Math feedback." }],
      quiz: [
        {
          question: "What guides reinforcement learning?",
          options: ["Reward signal", "Random noise", "Static table"],
          answerIndex: 0,
          explanation: "Feedback rewards model actions.",
        },
      ],
      discussionQuestions: ["How might rewards be gameable?"],
      activities: ["Design an objective function."],
    };

    const html = renderToStaticMarkup(
      createElement(LearningMaterialCard, {
        materials: { student },
        sources: SOURCES,
      }),
    );

    expect(html).toContain("Learning Material");
    expect(html).toContain("Learning via trial, error, and feedback loops.");
    expect(html).toContain("Reward Function");
    expect(html).toContain("Math feedback.");
    expect(html).toContain("What guides reinforcement learning?");
    expect(html).toContain("Reward signal");
    expect(html).toContain("How might rewards be gameable?");
    expect(html).toContain("Design an objective function.");
  });

  it("returns null when no materials are provided", () => {
    const html = renderToStaticMarkup(
      createElement(LearningMaterialCard, {
        materials: {},
        sources: SOURCES,
      }),
    );
    expect(html).toBe("");
  });

  it("rejects quiz with answerIndex out of bounds", () => {
    const invalidQuiz = {
      question: "Which model?",
      options: ["Option A", "Option B"],
      answerIndex: 5,
      explanation: "Out of bounds answer",
    };
    const res = quizQuestionSchema.safeParse(invalidQuiz);
    expect(res.success).toBe(false);
  });
});

describe("PolicyImpactCard", () => {
  it("renders policy explorer sections correctly", () => {
    const policy: PolicyImpactExplorer = {
      policyName: "AI in K-12 Guidelines",
      summary: "Comprehensive framework for classroom adoption",
      affectedAudiences: [
        {
          group: "Teachers",
          impact: "Need 20 hours professional development",
        },
      ],
      timeline: [
        {
          phase: "Phase 1",
          milestone: "Rolling out Fall 2026",
        },
      ],
      remainingUncertainties: ["Funding allocation pending legislative vote"],
    };

    const html = renderToStaticMarkup(
      createElement(PolicyImpactCard, { policy }),
    );

    expect(html).toContain("Policy Impact Explorer");
    expect(html).toContain("AI in K-12 Guidelines");
    expect(html).toContain("Comprehensive framework for classroom adoption");
    expect(html).toContain("Teachers");
    expect(html).toContain("Need 20 hours professional development");
    expect(html).toContain("Rolling out Fall 2026");
    expect(html).toContain("Funding allocation pending legislative vote");
  });
});

describe("ClassroomDiscussionCard", () => {
  it("renders classroom discussion guide properly", () => {
    const guide: ClassroomDiscussionBuilder = {
      topic: "Ethics of Automated Essay Scoring",
      gradeLevels: ["High School", "Undergraduate"],
      discussionQuestions: [
        {
          question: "Can an algorithm evaluate student voice?",
          learningGoal: "Probe definition of creativity",
        },
      ],
      classroomActivities: [
        {
          activity: "Peer vs. Model Evaluation Lab",
          instructions: "Score sample essays by hand then compare",
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(ClassroomDiscussionCard, { guide }),
    );

    expect(html).toContain("Classroom Discussion Builder");
    expect(html).toContain("Ethics of Automated Essay Scoring");
    expect(html).toContain("High School");
    expect(html).toContain("Undergraduate");
    expect(html).toContain("Can an algorithm evaluate student voice?");
    expect(html).toContain("Probe definition of creativity");
    expect(html).toContain("Peer vs. Model Evaluation Lab");
    expect(html).toContain("Score sample essays by hand then compare");
  });
});

describe("EducationEvidenceCard", () => {
  it("renders empirical evidence check details", () => {
    const evidence: EducationEvidenceChecker = {
      subject: "AI Math Tutor Pro",
      claimedOutcomes: "Increases test scores by 2 standard deviations",
      measuredOutcomes: "Modest gains of 0.15 SD in small subgroup",
      promotionalGap: "Vendor cited internal unverified pilot as proof",
      studyDesign: {
        samplePopulation: "42 students in pilot district",
        comparisonGroup: "None (pre-test / post-test only)",
        metricUsed: "Internal quiz results",
      },
      limitations: ["No control group", "High attrition rate"],
    };

    const html = renderToStaticMarkup(
      createElement(EducationEvidenceCard, { evidence }),
    );

    expect(html).toContain("Education Evidence Checker");
    expect(html).toContain("AI Math Tutor Pro");
    expect(html).toContain("Increases test scores by 2 standard deviations");
    expect(html).toContain("Modest gains of 0.15 SD in small subgroup");
    expect(html).toContain("Vendor cited internal unverified pilot as proof");
    expect(html).toContain("42 students in pilot district");
    expect(html).toContain("No control group");
  });
});

describe("FinanceRealityCheckCard", () => {
  it("renders backtest audit and reality check details", () => {
    const check: FinanceRealityCheck = {
      claimant: "Quant Alpha Fund",
      claimSummary: "Sharpe Ratio 3.8 with zero down months",
      claimType: "backtest",
      testPeriodAndBenchmark: "2018 - 2024 vs S&P 500",
      costsAndAssumptions: "Zero slippage and zero market impact modeled",
      disclosedCautions: ["Tail risk during liquidity crunches not priced"],
    };

    const html = renderToStaticMarkup(
      createElement(FinanceRealityCheckCard, { check }),
    );

    expect(html).toContain("AI-in-Finance Reality Check");
    expect(html).toContain("Quant Alpha Fund");
    expect(html).toContain("Sharpe Ratio 3.8 with zero down months");
    expect(html).toContain("2018 - 2024 vs S&amp;P 500");
    expect(html).toContain("Zero slippage and zero market impact modeled");
    expect(html).toContain("Tail risk during liquidity crunches not priced");
  });
});

describe("RegulationWatchCard", () => {
  it("renders regulation watch breakdown", () => {
    const watch: RegulationWatch = {
      regulator: "SEC & CFTC",
      actionTitle: "Predictive Analytics Rulemaking",
      summary: "Proposed rulemaking on predictive data analytics in trading",
      affectedInstitutions: ["Broker-dealers", "Investment advisers"],
      keyRequirements: [
        "Eliminate or neutralize conflicts of interest in algorithms",
      ],
      effectiveDate: "Comment period ends in 60 days",
      enforcementContext: "2023 Enforcement actions against dark pools",
    };

    const html = renderToStaticMarkup(
      createElement(RegulationWatchCard, { watch }),
    );

    expect(html).toContain("Regulation Watch");
    expect(html).toContain("SEC &amp; CFTC");
    expect(html).toContain("Predictive Analytics Rulemaking");
    expect(html).toContain("Broker-dealers");
    expect(html).toContain(
      "Eliminate or neutralize conflicts of interest in algorithms",
    );
    expect(html).toContain("Comment period ends in 60 days");
    expect(html).toContain("2023 Enforcement actions against dark pools");
  });
});

describe("FinanceConceptCard", () => {
  it("renders financial concept explainer", () => {
    const concept: FinanceConceptExplainer = {
      conceptName: "Liquidity Spiral",
      plainEnglishDefinition:
        "A chain reaction where falling asset prices trigger margin calls, forcing more selling.",
      applicationInStory:
        "Why the algorithmic stablecoin collapsed under sudden redemption pressure.",
      commonPitfalls: [
        "Believing liquidity is always guaranteed by arbitrageurs.",
      ],
      keyTakeaways: ["Check depth of order book under stress."],
    };

    const html = renderToStaticMarkup(
      createElement(FinanceConceptCard, { concept }),
    );

    expect(html).toContain("Finance Concepts for Learners");
    expect(html).toContain("Liquidity Spiral");
    expect(html).toContain(
      "A chain reaction where falling asset prices trigger margin calls",
    );
    expect(html).toContain(
      "Believing liquidity is always guaranteed by arbitrageurs.",
    );
    expect(html).toContain("Check depth of order book under stress.");
  });
});

describe("SkillsCareerTrendsCard", () => {
  it("renders skills and career trends breakdown", () => {
    const trends: SkillsCareerTrends = {
      industryShift:
        "Transition from manual prompt craft to autonomous agent orchestration",
      emergingSkills: [
        "Agentic workflow debugging",
        "Evals engineering",
        "Safety sandboxing",
      ],
      decliningOrAtRiskSkills: [
        "Manual copy formatting",
        "Basic regex drafting",
      ],
      affectedOccupations: [
        {
          role: "Junior Software QA",
          impact:
            "Shift towards maintaining automated test suites and behavioral evals.",
        },
      ],
      trainingRecommendations: [
        "Focus on system architecture and domain validation skills.",
      ],
    };

    const html = renderToStaticMarkup(
      createElement(SkillsCareerTrendsCard, { trends }),
    );

    expect(html).toContain("Skills and Career Trends");
    expect(html).toContain(
      "Transition from manual prompt craft to autonomous agent orchestration",
    );
    expect(html).toContain("Agentic workflow debugging");
    expect(html).toContain("Manual copy formatting");
    expect(html).toContain("Junior Software QA");
    expect(html).toContain("Shift towards maintaining automated test suites");
    expect(html).toContain(
      "Focus on system architecture and domain validation skills.",
    );
  });

  describe("IndustryImpactCard (Issue #21)", () => {
    it("renders summary, industries, badges, quotes and decisions", () => {
      const report: IndustryImpactReport = {
        summary: "Leading foundries transition to high-NA EUV tooling.",
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "Advanced substrate lead times lengthen to 24 weeks.",
            transmissionPath:
              "Front-end wafer starts outpace packaging capacity.",
            basis: "evidence_based",
            citation: {
              claimId: 789,
              quote: "Wait times grew to 24 weeks.",
            },
          },
          {
            industry: "Automotive Microcontrollers",
            impact: "Foundries reallocate legacy lines.",
            transmissionPath: "Fab conversion programs.",
            basis: "speculative",
            citation: null,
          },
        ],
        affectedOccupations: [
          {
            role: "Packaging Design Engineer",
            impact: "Adopting 2.5D interposer routing tools.",
            timeframe: "short_term",
            basis: "evidence_based",
            citation: { claimId: 790 },
          },
        ],
        decisionImplications: [
          {
            decisionMaker: "Procurement VP",
            recommendationOrTradeoff:
              "Secure substrate allocation 12 months ahead.",
            basis: "evidence_based",
            citation: {
              claimId: 791,
              sourceDomain: "semi.org",
              quote: "Lead times hit 52 weeks.",
            },
          },
        ],
      };

      const html = renderToStaticMarkup(
        createElement(IndustryImpactCard, { report }),
      );

      expect(html).toContain("Industry Impact Report");
      expect(html).toContain(
        "Leading foundries transition to high-NA EUV tooling.",
      );
      expect(html).toContain("Semiconductor Packaging");
      expect(html).toContain("Supported");
      expect(html).toContain("[Claim #789]");
      expect(html).toContain("Wait times grew to 24 weeks.");
      expect(html).toContain("Automotive Microcontrollers");
      expect(html).toContain("Speculative");
      expect(html).toContain("Packaging Design Engineer");
      expect(html).toContain("[Claim #790]");
      expect(html).toContain("Procurement VP");
      expect(html).toContain("[Claim #791]");
      expect(html).toContain("(semi.org)");
      expect(html).toContain("Lead times hit 52 weeks.");
      expect(html).toContain("Secure substrate allocation 12 months ahead.");
    });
  });

  describe("SupplyChainRippleCard (Issue #21)", () => {
    it("renders hypothesis warning banner, focal node, upstream and downstream ripples", () => {
      const ripple: SupplyChainRippleMap = {
        focalNode: "Foundry 3nm wafer fabrication expansion",
        upstreamRipples: [
          {
            target: "Photolithography Optics",
            effect: "High-NA mirrors delivery schedules tighten by 3 months.",
            transmissionChannel: "Fab tooling order acceleration.",
            isHypothesis: true,
            confidence: "high",
          },
        ],
        downstreamRipples: [
          {
            target: "Server Motherboard Integrators",
            effect: "Component allocation constraints on PCIe retimers.",
            transmissionChannel: "Accelerated ASIC production.",
            isHypothesis: true,
            confidence: "medium",
          },
        ],
        keyHypotheses: [
          "Supplier capacity can ramp within 6 months without compounding lead times.",
        ],
      };

      const html = renderToStaticMarkup(
        createElement(SupplyChainRippleCard, { ripple }),
      );

      expect(html).toContain("Supply-Chain Ripple Map");
      // Must contain the hypothesis warning banner
      expect(html).toContain(
        "Upstream and downstream ripple effects in the supply chain",
      );
      expect(html).toContain("Foundry 3nm wafer fabrication expansion");
      expect(html).toContain("Photolithography Optics");
      expect(html).toContain("High-NA mirrors delivery schedules tighten");
      expect(html).toContain("Hypothesis (high)");
      expect(html).toContain("Server Motherboard Integrators");
      expect(html).toContain("Hypothesis (medium)");
      expect(html).toContain(
        "Supplier capacity can ramp within 6 months without compounding lead times.",
      );
    });
  });
});

describe("EarningsDecoderCard (Issue #83)", () => {
  function decoderWithUrl(url: string): EarningsDecoder {
    const citation = (factId: number, periodEnd: string) => ({
      factId,
      secUrl: url,
      periodEnd,
    });
    return {
      company: { ticker: "AAPL", name: "Apple Inc.", cik: "0000320193" },
      filing: {
        form: "10-Q",
        fiscalYear: 2024,
        fiscalPeriod: "Q3",
        filingDate: "2024-08-02",
        secUrl: url,
        accessionNumber: "0000320193-24-000001",
      },
      metrics: [
        {
          metricName: "Total Revenue",
          concept: "Revenues",
          unit: "USD",
          reportedValue: "85777000000",
          reportedCitation: citation(101, "2024-06-29"),
          priorPeriodValue: "90753000000",
          priorPeriodCitation: citation(90, "2024-03-30"),
          priorYearValue: "81797000000",
          priorYearCitation: citation(50, "2023-07-01"),
          guidanceComparison: "not_provided",
        },
      ],
      executiveSummary: "Summary.",
      keyDrivers: ["Driver."],
      disclaimer: "Not investment advice.",
    };
  }

  it("drops non-http(s) hrefs from the filing link and every citation", () => {
    const html = renderToStaticMarkup(
      createElement(EarningsDecoderCard, {
        decoder: decoderWithUrl("javascript:alert(1)"),
      }),
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("View Official SEC Filing");
  });

  it("keeps https SEC links", () => {
    const url = "https://www.sec.gov/Archives/edgar/data/320193/x.htm";
    const html = renderToStaticMarkup(
      createElement(EarningsDecoderCard, { decoder: decoderWithUrl(url) }),
    );
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain("View Official SEC Filing");
  });
});

describe("artifact sources (#115)", () => {
  const brief: StoryBrief = {
    whatHappened: "What happened text",
    whatIsNew: "What is new text",
    whatEvidenceExists: "Evidence text",
    whatToWatchNext: "Watch next text",
  };
  const student: AudienceExplain = {
    audience: "student",
    overview: "Student overview text",
    keyPoints: ["Point A"],
    implications: ["Takeaway 1"],
    glossary: [],
  };
  const material: LearningMaterial = {
    audience: "student",
    conceptExplainer: "Learning via trial, error, and feedback loops.",
    glossary: [],
    quiz: [],
    discussionQuestions: [],
    activities: [],
  };

  it("StoryBriefCard shows source title, link, published and fetched time", () => {
    const html = renderToStaticMarkup(
      createElement(StoryBriefCard, { brief, sources: SOURCES }),
    );
    expectSourceInfo(html);
  });

  it("AudienceExplainCard shows source title, link, published and fetched time", () => {
    const html = renderToStaticMarkup(
      createElement(AudienceExplainCard, {
        explanations: { student },
        sources: SOURCES,
      }),
    );
    expectSourceInfo(html);
  });

  it("LearningMaterialCard shows source title, link, published and fetched time", () => {
    const html = renderToStaticMarkup(
      createElement(LearningMaterialCard, {
        materials: { student: material },
        sources: SOURCES,
      }),
    );
    expectSourceInfo(html);
  });

  it('ArtifactSources shows "Published not stated" when publishedAt is null', () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactSources, {
        sources: [{ ...SOURCES[0], publishedAt: null }],
      }),
    );
    expect(html).toContain("Published not stated");
    expect(html).toContain("Fetched");
    expect(html).toContain(formatUtc(FETCHED_AT));
    expect(html.match(/<time/g)).toHaveLength(1);
  });

  it("ArtifactSources renders nothing for an empty sources array", () => {
    expect(
      renderToStaticMarkup(createElement(ArtifactSources, { sources: [] })),
    ).toBe("");
  });

  it("artifact cards render nothing without sources", () => {
    expect(
      renderToStaticMarkup(
        createElement(StoryBriefCard, { brief, sources: [] }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(AudienceExplainCard, {
          explanations: { student },
          sources: [],
        }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(LearningMaterialCard, {
          materials: { student: material },
          sources: [],
        }),
      ),
    ).toBe("");
  });
});

// #131: the cards are imported inside the tests so that, before they exist,
// only these tests fail and the rest of the file still runs.
describe("Technology product cards (#131)", () => {
  const PROVENANCE_NOTE =
    "Quotes are checked against the source text; whether a benchmark is independent is not verified.";
  const check: LaunchRealityCheck = {
    subject: "Orion-2",
    claimant: "Acme",
    claims: [
      {
        claim: "Orion-2 scores 92 percent on CodeBench.",
        claimQuote: {
          articleId: 1,
          quote: "scores 92 percent on the CodeBench suite",
        },
        verdict: "independent_dispute",
        independentEvidence: [
          { articleId: 2, quote: "Orion-2 scored 81 percent on CodeBench" },
        ],
      },
    ],
  };
  const timeline: TechnologyEvolutionTimeline = {
    entries: [
      {
        date: "2026-10-20",
        dateSource: "report_published",
        kind: "release",
        description: "Acme released Orion-2.",
        source: { articleId: 1, quote: "Acme today released Orion-2, a model" },
      },
      {
        date: "March 2026",
        dateSource: "stated_in_text",
        kind: "evaluation",
        description: "The Open Eval Lab measured Orion-2.",
        source: {
          articleId: 2,
          quote: "Orion-2 scored 81 percent on CodeBench",
        },
      },
    ],
  };

  it("LaunchRealityCheckCard shows claims, verdicts, quotes and the three source fields", async () => {
    const { LaunchRealityCheckCard } =
      await import("../src/components/artifacts/LaunchRealityCheckCard");
    const html = renderToStaticMarkup(
      createElement(LaunchRealityCheckCard, { check, sources: SOURCES }),
    );
    expect(html).toContain("Launch Reality Check");
    expect(html).toContain("Orion-2 · Claims by Acme");
    expect(html).toContain(
      "1 of 1 claim has evidence from other outlets in these sources.",
    );
    expect(html).toContain("Other outlets report contrary evidence");
    expect(html).not.toContain("Independent evidence disputes this claim");
    expect(html).toContain(PROVENANCE_NOTE);
    expect(html).toContain("scores 92 percent on the CodeBench suite");
    expect(html).toContain("Orion-2 scored 81 percent on CodeBench");
    expect(html).toContain('href="/a/1"');
    expect(html).toContain('href="/a/2"');
    expectSourceInfo(html);
    // 375px guards of the card itself, not only of ArtifactSources.
    expect(html).toMatch(
      /^<section aria-label="Launch Reality Check" class="min-w-0 /,
    );
    expect(html).toContain('<li class="min-w-0 ');
    expect(html).toContain('<blockquote class="wrap-anywhere ');
    expect(html).toContain('<p class="wrap-anywhere text-sm font-bold">');
    expect(html).toContain("flex-wrap");
    // ArtifactSources is the last child of the section.
    expect(html).toMatch(/<\/footer><\/section>$/);
  });

  it("EvolutionTimelineCard shows dates, kinds, quotes and the three source fields", async () => {
    const { EvolutionTimelineCard } =
      await import("../src/components/artifacts/EvolutionTimelineCard");
    const html = renderToStaticMarkup(
      createElement(EvolutionTimelineCard, { timeline, sources: SOURCES }),
    );
    expect(html).toContain("Technology Evolution Timeline");
    expect(html).toContain("2026-10-20");
    expect(html).toContain("Date of report");
    expect(html.match(/Date of report/g)).toHaveLength(1);
    expect(html).toContain("Release");
    expect(html).toContain("Evaluation");
    expect(html).toContain("Acme today released Orion-2, a model");
    expect(html).toContain('href="/a/1"');
    expect(html).toContain('href="/a/2"');
    expect(html).toContain(PROVENANCE_NOTE);
    expectSourceInfo(html);
    expect(html).toMatch(
      /^<section aria-label="Technology Evolution Timeline" class="min-w-0 /,
    );
    expect(html).toContain('<li class="min-w-0 ');
    expect(html).toContain('<p class="flex flex-wrap ');
    expect(html).toContain('<blockquote class="wrap-anywhere ');
    expect(html).toMatch(/<\/footer><\/section>$/);
  });

  it("LaunchRealityCheckCard names each verdict by who reports the evidence", async () => {
    const { LaunchRealityCheckCard } =
      await import("../src/components/artifacts/LaunchRealityCheckCard");
    const base = check.claims[0];
    const html = renderToStaticMarkup(
      createElement(LaunchRealityCheckCard, {
        check: {
          ...check,
          claims: [
            { ...base, verdict: "independent_support" },
            { ...base, verdict: "independent_dispute" },
            {
              ...base,
              verdict: "no_independent_evidence",
              independentEvidence: [],
            },
          ],
        },
        sources: SOURCES,
      }),
    );
    expect(html).toContain("Other outlets report supporting evidence");
    expect(html).toContain("Other outlets report contrary evidence");
    expect(html).toContain("No other outlet reports evidence");
    expect(html).not.toContain("Independent evidence supports this claim");
    expect(html).not.toContain("No independent evidence in these sources");
    expect(html.match(new RegExp(PROVENANCE_NOTE, "g"))).toHaveLength(1);
  });

  it("Technology product cards show the verified quote, not the model's paraphrase", async () => {
    const { LaunchRealityCheckCard } =
      await import("../src/components/artifacts/LaunchRealityCheckCard");
    const { EvolutionTimelineCard } =
      await import("../src/components/artifacts/EvolutionTimelineCard");
    const quote = "The Orion-2 chip draws 50 mW of power at idle";
    expect(JSON.stringify(SOURCES)).not.toContain("50 MW");
    const launch = renderToStaticMarkup(
      createElement(LaunchRealityCheckCard, {
        check: {
          ...check,
          claims: [
            {
              claim: "Orion-2 draws 50 MW at idle.",
              claimQuote: { articleId: 1, quote },
              verdict: "no_independent_evidence",
              independentEvidence: [],
            },
          ],
        },
        sources: SOURCES,
      }),
    );
    expect(launch).toContain("50 mW");
    expect(launch).not.toContain("50 MW");
    expect(launch).toContain('href="/a/1"');

    const evolution = renderToStaticMarkup(
      createElement(EvolutionTimelineCard, {
        timeline: {
          entries: [
            {
              ...timeline.entries[0],
              description: "Acme released a 50 MW chip.",
              source: { articleId: 1, quote },
            },
            timeline.entries[1],
          ],
        },
        sources: SOURCES,
      }),
    );
    expect(evolution).toContain("50 mW");
    expect(evolution).not.toContain("50 MW");
    expect(evolution).toContain("2026-10-20");
  });

  it("Technology product cards render nothing without sources", async () => {
    const { LaunchRealityCheckCard } =
      await import("../src/components/artifacts/LaunchRealityCheckCard");
    const { EvolutionTimelineCard } =
      await import("../src/components/artifacts/EvolutionTimelineCard");
    expect(
      renderToStaticMarkup(
        createElement(LaunchRealityCheckCard, { check, sources: [] }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(EvolutionTimelineCard, { timeline, sources: [] }),
      ),
    ).toBe("");
  });
});
