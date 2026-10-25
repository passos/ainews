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
  parseIndustryImpactReportOutput,
  parseSupplyChainRippleMapOutput,
  type ArtifactEventMaterial,
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

  describe("parseIndustryImpactReportOutput (Issue #21)", () => {
    const valid = {
      summary:
        "Foundry capacity shift causes ripple effects across edge compute.",
      affectedIndustries: [
        {
          industry: "Semiconductor Packaging",
          impact: "CoWoS advanced packaging lines face lead time expansion.",
          transmissionPath:
            "Foundry front-end wafer orders exceed packaging capacity.",
          basis: "evidence_based",
          citation: {
            claimId: 101,
            sourceDomain: "semianalysis.com",
            quote: "Advanced packaging wait times grew to 24 weeks.",
          },
        },
        {
          industry: "Automotive Electronics",
          impact: "Legacy microcontroller migration accelerates.",
          transmissionPath:
            "Price adjustments on mature nodes force OEM redesigns.",
          basis: "speculative",
          citation: null,
        },
      ],
      affectedOccupations: [
        {
          role: "Hardware Systems Architect",
          impact:
            "Must evaluate multi-chiplet alternatives to single monolithic dies.",
          timeframe: "short_term",
          basis: "evidence_based",
          citation: {
            claimId: 102,
          },
        },
      ],
      decisionImplications: [
        {
          decisionMaker: "Supply Chain Director",
          recommendationOrTradeoff:
            "Dual-source secondary packaging partners to hedge against yield bottlenecks.",
          basis: "speculative",
          citation: null,
        },
      ],
    };

    const mockMaterial: ArtifactEventMaterial = {
      eventId: 42,
      eventTitle: "3nm Wafer Packaging Dynamics",
      industryName: "Industry",
      industrySlug: "industry",
      articles: [
        {
          id: 201,
          title: "Semiconductor Supply Shifts",
          sourceName: "Tech Report",
          sourceDomain: "semianalysis.com",
          publishedAt: Date.now(),
          summary: "Packaging delays impact shipment schedules.",
          bodyText:
            "Advanced packaging wait times grew to 24 weeks according to industry disclosures.",
        },
      ],
      verifiedClaims: [
        {
          id: 101,
          claimText: "Advanced packaging wait times grew to 24 weeks.",
          claimType: "fact",
          consensusStatus: "verified",
        },
        {
          id: 102,
          claimText: "Architects are transitioning to multi-chiplet designs.",
          claimType: "interpretation",
          consensusStatus: "verified",
        },
      ],
    };

    it("parses valid JSON with citations successfully", () => {
      const res = parseIndustryImpactReportOutput(
        JSON.stringify(valid),
        mockMaterial,
      );
      expect(res).not.toBeNull();
      expect(res?.affectedIndustries[0].basis).toBe("evidence_based");
      expect(res?.affectedIndustries[0].citation?.claimId).toBe(101);
      expect(res?.affectedIndustries[1].basis).toBe("speculative");
    });

    it("parses markdown code-fenced JSON successfully", () => {
      const fenced = "```json\n" + JSON.stringify(valid) + "\n```";
      const res = parseIndustryImpactReportOutput(fenced, mockMaterial);
      expect(res).not.toBeNull();
      expect(res?.summary).toBe(valid.summary);
    });

    it("returns null on malformed JSON or empty string", () => {
      expect(
        parseIndustryImpactReportOutput("not a json", mockMaterial),
      ).toBeNull();
      expect(parseIndustryImpactReportOutput("", mockMaterial)).toBeNull();
    });

    it("returns null when basis is evidence_based but citation is missing or empty (M1 defense)", () => {
      const invalidNoCitation = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "CoWoS lines face delays.",
            transmissionPath: "Capacity shortage.",
            basis: "evidence_based",
            citation: null, // invalid!
          },
        ],
      };
      expect(
        parseIndustryImpactReportOutput(
          JSON.stringify(invalidNoCitation),
          mockMaterial,
        ),
      ).toBeNull();

      const invalidEmptyCitation = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "CoWoS lines face delays.",
            transmissionPath: "Capacity shortage.",
            basis: "evidence_based",
            citation: {}, // missing claimId and quote!
          },
        ],
      };
      expect(
        parseIndustryImpactReportOutput(
          JSON.stringify(invalidEmptyCitation),
          mockMaterial,
        ),
      ).toBeNull();
    });

    it("downgrades phantom/unverified claim citations to speculative (M4 defense)", () => {
      const phantomPayload = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "CoWoS advanced packaging lines face lead time expansion.",
            transmissionPath:
              "Foundry front-end wafer orders exceed packaging capacity.",
            basis: "evidence_based",
            citation: {
              claimId: 99999, // phantom claimId not in mockMaterial!
            },
          },
        ],
      };

      const res = parseIndustryImpactReportOutput(
        JSON.stringify(phantomPayload),
        mockMaterial,
      );
      expect(res).not.toBeNull();
      // Must be safely downgraded to speculative and citation cleared
      expect(res?.affectedIndustries[0].basis).toBe("speculative");
      expect(res?.affectedIndustries[0].citation).toBeNull();
    });

    it("validates direct article quote if claimId is omitted but articleId and quote match", () => {
      const quotePayload = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "Packaging lines delay shipment.",
            transmissionPath: "Wait times increase.",
            basis: "evidence_based",
            citation: {
              articleId: 201,
              quote: "Advanced packaging wait times grew to 24 weeks",
            },
          },
        ],
      };

      const res = parseIndustryImpactReportOutput(
        JSON.stringify(quotePayload),
        mockMaterial,
      );
      expect(res).not.toBeNull();
      expect(res?.affectedIndustries[0].basis).toBe("evidence_based");
      expect(res?.affectedIndustries[0].citation?.articleId).toBe(201);
    });
  });

  describe("parseSupplyChainRippleMapOutput (Issue #21)", () => {
    const valid = {
      focalNode: "Foundry 3nm wafer fabrication expansion",
      upstreamRipples: [
        {
          target: "EUV Photolithography Optics",
          effect:
            "High-NA optics mirrors delivery schedules tighten by 3 months.",
          transmissionChannel: "Fab tooling order acceleration.",
          isHypothesis: true,
          confidence: "high",
        },
      ],
      downstreamRipples: [
        {
          target: "Hyperscale Server Motherboards",
          effect:
            "Transition to PCIe 6.0 retimers faces component allocation constraints.",
          transmissionChannel:
            "Accelerated ASIC production pulls forward interconnect inventory.",
          isHypothesis: true,
          confidence: "medium",
        },
      ],
      keyHypotheses: [
        "Supplier capacity can ramp within 6 months without compounding lead times.",
      ],
    };

    it("parses valid JSON with isHypothesis: true successfully", () => {
      const res = parseSupplyChainRippleMapOutput(JSON.stringify(valid));
      expect(res).toEqual(valid);
      expect(res?.upstreamRipples[0].isHypothesis).toBe(true);
      expect(res?.downstreamRipples[0].isHypothesis).toBe(true);
    });

    it("parses markdown code-fenced JSON successfully", () => {
      const fenced = "```json\n" + JSON.stringify(valid) + "\n```";
      const res = parseSupplyChainRippleMapOutput(fenced);
      expect(res).toEqual(valid);
    });

    it("returns null on malformed JSON or missing required fields", () => {
      expect(parseSupplyChainRippleMapOutput("not json")).toBeNull();
      expect(
        parseSupplyChainRippleMapOutput(
          JSON.stringify({ focalNode: "Incomplete" }),
        ),
      ).toBeNull();
    });

    it("rejects when isHypothesis is false or omitted (M2 mutation defense)", () => {
      const invalidFalse = {
        ...valid,
        upstreamRipples: [
          {
            target: "EUV Photolithography Optics",
            effect: "High-NA optics mirrors delivery schedules tighten.",
            transmissionChannel: "Fab tooling order acceleration.",
            isHypothesis: false, // Must be true!
            confidence: "high",
          },
        ],
      };
      expect(
        parseSupplyChainRippleMapOutput(JSON.stringify(invalidFalse)),
      ).toBeNull();

      const invalidOmitted = {
        ...valid,
        downstreamRipples: [
          {
            target: "Hyperscale Server Motherboards",
            effect: "Transition to PCIe 6.0 retimers faces constraints.",
            transmissionChannel: "Accelerated ASIC production.",
            // isHypothesis omitted!
            confidence: "medium",
          },
        ],
      };
      expect(
        parseSupplyChainRippleMapOutput(JSON.stringify(invalidOmitted)),
      ).toBeNull();
    });
  });
});
