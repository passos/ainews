import { describe, expect, it } from "vitest";
import {
  parseClassroomDiscussionBuilderOutput,
  parseEducationEvidenceCheckerOutput,
  parseFinanceConceptExplainerOutput,
  parseFinanceRealityCheckOutput,
  parseLearningMaterialOutput,
  parsePolicyImpactExplorerOutput,
  parseRegulationWatchOutput,
  parseSkillsCareerTrendsOutput,
} from "../../src/pipeline/artifacts/prompts";

describe("Artifact Output Parsers (Issue #20)", () => {
  describe("parseLearningMaterialOutput", () => {
    const valid = {
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
      activities: ["Try translating a sentence with and without context."],
    };

    it("parses valid JSON successfully", () => {
      const res = parseLearningMaterialOutput(JSON.stringify(valid));
      expect(res).toEqual(valid);
    });

    it("parses markdown code-fenced JSON successfully", () => {
      const fenced = "```json\n" + JSON.stringify(valid) + "\n```";
      const res = parseLearningMaterialOutput(fenced);
      expect(res).toEqual(valid);
    });

    it("returns null on malformed JSON or empty string", () => {
      expect(parseLearningMaterialOutput("not json")).toBeNull();
      expect(parseLearningMaterialOutput("{")).toBeNull();
      expect(parseLearningMaterialOutput("")).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      const missing = { ...valid, conceptExplainer: undefined };
      expect(parseLearningMaterialOutput(JSON.stringify(missing))).toBeNull();
    });

    it("returns null when quiz answerIndex is out of options bounds", () => {
      const invalidQuiz = {
        ...valid,
        quiz: [
          {
            question: "Question?",
            options: ["Option A", "Option B"],
            answerIndex: 5, // out of bounds!
            explanation: "Invalid index",
          },
        ],
      };
      expect(
        parseLearningMaterialOutput(JSON.stringify(invalidQuiz)),
      ).toBeNull();
    });
  });

  describe("parsePolicyImpactExplorerOutput", () => {
    const valid = {
      policyName: "Federal K-12 AI Directives",
      summary: "Guidelines on AI software usage in public education.",
      affectedAudiences: [
        {
          group: "Teachers",
          impact: "Mandatory algorithmic literacy training",
        },
      ],
      timeline: [{ phase: "Fall 2026", milestone: "Drafting state standards" }],
      remainingUncertainties: ["Federal funding allocations"],
    };

    it("parses valid JSON successfully", () => {
      expect(parsePolicyImpactExplorerOutput(JSON.stringify(valid))).toEqual(
        valid,
      );
    });

    it("returns null on malformed JSON or schema violation", () => {
      expect(parsePolicyImpactExplorerOutput("invalid json")).toBeNull();
      expect(
        parsePolicyImpactExplorerOutput(
          JSON.stringify({ summary: "No policyName" }),
        ),
      ).toBeNull();
    });
  });

  describe("parseClassroomDiscussionBuilderOutput", () => {
    const valid = {
      topic: "AI Ethics in Academic Honesty",
      gradeLevels: ["Middle School", "High School"],
      discussionQuestions: [
        {
          question: "When does an AI helper become academic dishonesty?",
          learningGoal: "Understand intellectual integrity vs tool use",
        },
      ],
      classroomActivities: [
        {
          activity: "Mock School Board Policy Debate",
          instructions: "Split students into teachers, parents, and students.",
        },
      ],
    };

    it("parses valid JSON successfully", () => {
      expect(
        parseClassroomDiscussionBuilderOutput(JSON.stringify(valid)),
      ).toEqual(valid);
    });

    it("returns null on malformed JSON or schema violation", () => {
      expect(parseClassroomDiscussionBuilderOutput("invalid json")).toBeNull();
      expect(
        parseClassroomDiscussionBuilderOutput(
          JSON.stringify({ topic: "Only topic" }),
        ),
      ).toBeNull();
    });
  });

  describe("parseEducationEvidenceCheckerOutput", () => {
    const valid = {
      subject: "Adaptive Math Tutoring AI",
      claimedOutcomes: "Improves test scores by 2 standard deviations.",
      measuredOutcomes:
        "Showed a 0.15 standard deviation gain in controlled trial.",
      studyDesign: {
        samplePopulation: "300 Grade 8 students across 4 urban schools",
        comparisonGroup: "Standard paper curriculum without software",
        metricUsed: "NWEA MAP Mathematics assessment",
      },
      promotionalGap:
        "Vendor claimed 2 SD but peer-reviewed result was only 0.15 SD.",
      limitations: [
        "Sample restricted to urban schools with high device access",
      ],
    };

    it("parses valid JSON successfully", () => {
      expect(
        parseEducationEvidenceCheckerOutput(JSON.stringify(valid)),
      ).toEqual(valid);
    });

    it("returns null on malformed JSON or schema violation", () => {
      expect(parseEducationEvidenceCheckerOutput("invalid json")).toBeNull();
      expect(
        parseEducationEvidenceCheckerOutput(
          JSON.stringify({ subject: "No studyDesign" }),
        ),
      ).toBeNull();
    });
  });

  describe("parseFinanceRealityCheckOutput", () => {
    const valid = {
      claimant: "Quant Capital Management",
      claimSummary:
        "Proprietary transformer model generates 35% annualized Sharpe 4.0 alpha.",
      claimType: "backtest" as const,
      testPeriodAndBenchmark:
        "2018-2024 simulated against S&P 500 Total Return",
      costsAndAssumptions:
        "Assumed zero transaction costs and zero market impact on mid-cap equities.",
      disclosedCautions: [
        "Backtest results do not represent actual trading.",
        "Severe slippage expected during high-volatility regimes.",
      ],
    };

    it("parses valid JSON successfully", () => {
      expect(parseFinanceRealityCheckOutput(JSON.stringify(valid))).toEqual(
        valid,
      );
    });

    it("returns null on malformed JSON or invalid enum value", () => {
      expect(parseFinanceRealityCheckOutput("invalid json")).toBeNull();
      const invalidEnum = { ...valid, claimType: "unsupported_type" };
      expect(
        parseFinanceRealityCheckOutput(JSON.stringify(invalidEnum)),
      ).toBeNull();
    });
  });

  describe("parseRegulationWatchOutput", () => {
    const valid = {
      regulator: "Securities and Exchange Commission (SEC)",
      actionTitle: "Algorithmic Risk Governance Examination Notice",
      summary:
        "Examiners will inspect predictive data analytics models used in broker-dealer recommendations.",
      affectedInstitutions: [
        "Registered broker-dealers",
        "Retail algorithmic trading platforms",
      ],
      keyRequirements: [
        "Maintain audit trails of model revisions",
        "Document conflict-of-interest neutralization procedures",
      ],
      effectiveDate: "November 1, 2026",
      enforcementContext:
        "Follows several enforcement inquiries regarding deceptive backtests.",
    };

    it("parses valid JSON successfully", () => {
      expect(parseRegulationWatchOutput(JSON.stringify(valid))).toEqual(valid);
    });

    it("returns null on malformed JSON or missing fields", () => {
      expect(parseRegulationWatchOutput("invalid json")).toBeNull();
      expect(
        parseRegulationWatchOutput(JSON.stringify({ regulator: "SEC" })),
      ).toBeNull();
    });
  });

  describe("parseFinanceConceptExplainerOutput", () => {
    const valid = {
      conceptName: "Adverse Selection in Automated Market Making",
      plainEnglishDefinition:
        "When informed traders pick off stale quotes before the algorithm adjusts.",
      applicationInStory:
        "The liquidity provider lost capital because latency arbitrageurs front-ran quote refreshes.",
      commonPitfalls: [
        "Believing high trading volume guarantees profitability",
        "Ignoring toxicity of incoming order flow",
      ],
      keyTakeaways: [
        "Spread must compensate for adverse selection risk, not just exchange fees",
      ],
    };

    it("parses valid JSON successfully", () => {
      expect(parseFinanceConceptExplainerOutput(JSON.stringify(valid))).toEqual(
        valid,
      );
    });

    it("returns null on malformed JSON or schema violation", () => {
      expect(parseFinanceConceptExplainerOutput("invalid json")).toBeNull();
      expect(
        parseFinanceConceptExplainerOutput(
          JSON.stringify({ conceptName: "Only name" }),
        ),
      ).toBeNull();
    });
  });

  describe("parseSkillsCareerTrendsOutput", () => {
    const valid = {
      industryShift:
        "Widespread enterprise adoption of retrieval-augmented generation in customer operations.",
      emergingSkills: [
        "Vector database schema optimization",
        "Agent evaluation benchmark engineering",
      ],
      decliningOrAtRiskSkills: [
        "Manual keyword rule-base authoring",
        "Tier-1 script-based telephone triage",
      ],
      affectedOccupations: [
        {
          role: "Customer Support Specialist",
          impact:
            "Shifts from answering routine queries to auditing AI agent resolution accuracy",
        },
      ],
      trainingRecommendations: [
        "Upskill in prompt evaluation frameworks and data quality auditing",
      ],
    };

    it("parses valid JSON successfully", () => {
      expect(parseSkillsCareerTrendsOutput(JSON.stringify(valid))).toEqual(
        valid,
      );
    });

    it("returns null on malformed JSON or schema violation", () => {
      expect(parseSkillsCareerTrendsOutput("invalid json")).toBeNull();
      expect(
        parseSkillsCareerTrendsOutput(
          JSON.stringify({ industryShift: "Missing other fields" }),
        ),
      ).toBeNull();
    });
  });
});
