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
  parseEarningsDecoderOutput,
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
          canonicalUrl: "https://semianalysis.com/packaging",
          publishedAt: Date.now(),
          summary: "Packaging delays impact shipment schedules.",
          bodyText:
            "Advanced packaging wait times grew to 24 weeks according to industry disclosures.",
          sourceBodyText:
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

    it("downgrades disputed or unverified claims to speculative (P2 defense)", () => {
      const disputedMaterial: ArtifactEventMaterial = {
        ...mockMaterial,
        verifiedClaims: [
          {
            id: 103,
            claimText: "Disputed packaging throughput claim.",
            claimType: "prediction",
            consensusStatus: "disputed", // Disputed!
          },
        ],
      };

      const payload = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Packaging",
            impact: "Throughput claims are challenged.",
            transmissionPath: "Vendor debate.",
            basis: "evidence_based",
            citation: {
              claimId: 103,
            },
          },
        ],
      };

      const res = parseIndustryImpactReportOutput(
        JSON.stringify(payload),
        disputedMaterial,
      );
      expect(res).not.toBeNull();
      // Disputed claims cannot support evidence_based badge; must be downgraded
      expect(res?.affectedIndustries[0].basis).toBe("speculative");
      expect(res?.affectedIndustries[0].citation).toBeNull();
    });

    it("sanitizes hallucinated quote attached to a valid claimId (P1 defense)", () => {
      const payload = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "CoWoS lines face lead time expansion.",
            transmissionPath: "Wafer volume exceeds packaging.",
            basis: "evidence_based",
            citation: {
              claimId: 101, // Valid claim!
              articleId: 201,
              quote: "Completely fabricated quote never present in body", // Fake quote!
            },
          },
        ],
      };

      const res = parseIndustryImpactReportOutput(
        JSON.stringify(payload),
        mockMaterial,
      );
      expect(res).not.toBeNull();
      expect(res?.affectedIndustries[0].basis).toBe("evidence_based");
      expect(res?.affectedIndustries[0].citation?.claimId).toBe(101);
      // Fabricated quote must be stripped so it is not shown under Verified badge
      expect(res?.affectedIndustries[0].citation?.quote).toBeUndefined();
      expect(res?.affectedIndustries[0].citation?.articleId).toBeUndefined();
    });

    it("rejects quotes that only exist in AI summary or title and not raw bodyText (P1 defense)", () => {
      const summaryQuotePayload = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "Packaging lines delay shipment.",
            transmissionPath: "Wait times increase.",
            basis: "evidence_based",
            citation: {
              articleId: 201,
              // This sentence is in article.summary but NOT in raw bodyText
              quote: "Packaging delays impact shipment schedules.",
            },
          },
        ],
      };

      const res = parseIndustryImpactReportOutput(
        JSON.stringify(summaryQuotePayload),
        mockMaterial,
      );
      expect(res).not.toBeNull();
      // Must be downgraded because summary is not raw proof
      expect(res?.affectedIndustries[0].basis).toBe("speculative");
      expect(res?.affectedIndustries[0].citation).toBeNull();
    });

    it("rejects whitespace or trivial quotes (P1 defense)", () => {
      const trivialPayload = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "Packaging lines delay shipment.",
            transmissionPath: "Wait times increase.",
            basis: "evidence_based",
            citation: {
              articleId: 201,
              quote: "   ",
            },
          },
        ],
      };

      const res = parseIndustryImpactReportOutput(
        JSON.stringify(trivialPayload),
        mockMaterial,
      );
      expect(res).not.toBeNull();
      expect(res?.affectedIndustries[0].basis).toBe("speculative");
      expect(res?.affectedIndustries[0].citation).toBeNull();
    });

    it("clears phantom claimId when fallback quote matches an actual article (Seat 1 P2 defense)", () => {
      const fallbackPayload = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "Packaging lines delay shipment.",
            transmissionPath: "Wait times increase.",
            basis: "evidence_based",
            citation: {
              claimId: 99999, // Phantom claimId!
              quote: "Advanced packaging wait times grew to 24 weeks", // Real quote!
            },
          },
        ],
      };

      const res = parseIndustryImpactReportOutput(
        JSON.stringify(fallbackPayload),
        mockMaterial,
      );
      expect(res).not.toBeNull();
      expect(res?.affectedIndustries[0].basis).toBe("evidence_based");
      // Phantom claimId must be cleared so UI does not display [Claim #99999]
      expect(res?.affectedIndustries[0].citation?.claimId).toBeUndefined();
      expect(res?.affectedIndustries[0].citation?.articleId).toBe(201);
      expect(res?.affectedIndustries[0].citation?.sourceDomain).toBe(
        "semianalysis.com",
      );
    });

    it("clears model-fabricated sourceDomain when claim is verified without verified quote (Seat 1 P2 defense)", () => {
      const fakeDomainPayload = {
        ...valid,
        affectedIndustries: [
          {
            industry: "Semiconductor Packaging",
            impact: "CoWoS lines face lead time expansion.",
            transmissionPath: "Capacity shortage.",
            basis: "evidence_based",
            citation: {
              claimId: 101,
              sourceDomain: "fabricated-authority.test", // Hallucinated domain!
            },
          },
        ],
      };

      const res = parseIndustryImpactReportOutput(
        JSON.stringify(fakeDomainPayload),
        mockMaterial,
      );
      expect(res).not.toBeNull();
      expect(res?.affectedIndustries[0].basis).toBe("evidence_based");
      expect(res?.affectedIndustries[0].citation?.claimId).toBe(101);
      // Hallucinated sourceDomain must be stripped
      expect(res?.affectedIndustries[0].citation?.sourceDomain).toBeUndefined();
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

  describe("parseEarningsDecoderOutput (Issue #22)", () => {
    const validMetric = {
      metricName: "Total Revenue",
      concept: "Revenues",
      unit: "USD",
      reportedValue: "94930000000",
      reportedCitation: {
        factId: 101,
        secUrl: "https://www.sec.gov/edgar/data/320193/fact101",
        quote: "Total net sales were $94,930 million",
        periodEnd: "2024-09-28",
      },
      priorPeriodValue: "85777000000",
      priorPeriodCitation: {
        factId: 90,
        secUrl: "https://www.sec.gov/edgar/data/320193/fact90",
        periodEnd: "2024-06-29",
      },
      deltaQoQPercent: "+10.7%",
      priorYearValue: "89498000000",
      priorYearCitation: {
        factId: 50,
        secUrl: "https://www.sec.gov/edgar/data/320193/fact50",
        periodEnd: "2023-09-30",
      },
      deltaYoYPercent: "+6.1%",
      guidanceComparison: "above" as const,
    };

    const validPayload = {
      company: {
        ticker: "AAPL",
        name: "Apple Inc.",
        cik: "0000320193",
      },
      filing: {
        form: "10-K",
        fiscalYear: 2024,
        fiscalPeriod: "Q4",
        filingDate: "2024-11-01",
        secUrl:
          "https://www.sec.gov/Archives/edgar/data/320193/000032019324000106/aapl-20240928.htm",
        accessionNumber: "0000320193-24-000106",
      },
      metrics: [validMetric],
      executiveSummary:
        "Apple reported strong fourth quarter results driven by iPhone and Services expansion.",
      keyDrivers: [
        "Services revenue reached an all-time high.",
        "Gross margin expanded to 46.2%.",
      ],
      forwardGuidance: [
        "Management expects low-to-mid single digit revenue growth next quarter.",
      ],
      disclaimer:
        "本简报仅供资讯与学习参考，基于公开 SEC 申报文件生成，不构成任何投资建议、买卖要约或金融决策依据。",
    };

    const mockMaterial = {
      eventId: 1,
      eventTitle: "Apple Q4 Earnings",
      industryName: "Finance",
      industrySlug: "finance",
      articles: [],
      calculatedMetrics: [validMetric],
      filing: {
        id: 1,
        accessionNumber: "0000320193-24-000106",
        form: "10-K",
        filingDate: "2024-11-01",
        secUrl: "https://sec.gov/filing/1",
        companyTicker: "AAPL",
        companyName: "Apple Inc.",
        companyCik: "0000320193",
      },
    };

    it("parses valid JSON with metrics and citations successfully", () => {
      const res = parseEarningsDecoderOutput(JSON.stringify(validPayload));
      expect(res).not.toBeNull();
      expect(res?.company.ticker).toBe("AAPL");
      expect(res?.metrics[0].reportedValue).toBe("94930000000");
      expect(res?.metrics[0].deltaQoQPercent).toBe("+10.7%");
      expect(res?.disclaimer).toContain("不构成任何投资建议");
    });

    it("parses markdown code-fenced JSON successfully", () => {
      const fenced = "```json\n" + JSON.stringify(validPayload) + "\n```";
      const res = parseEarningsDecoderOutput(fenced);
      expect(res).not.toBeNull();
      expect(res?.company.ticker).toBe("AAPL");
    });

    it("uses pre-computed calculatedMetrics from material if provided", () => {
      const rawLlmOutput = JSON.stringify({
        executiveSummary: "LLM summarized Q4 earnings.",
        keyDrivers: ["Growth in Cloud and Hardware."],
      });

      const res = parseEarningsDecoderOutput(
        rawLlmOutput,
        mockMaterial as unknown as ArtifactEventMaterial,
      );
      expect(res).not.toBeNull();
      expect(res?.metrics.length).toBe(1);
      expect(res?.metrics[0].reportedValue).toBe("94930000000");
      expect(res?.executiveSummary).toBe("LLM summarized Q4 earnings.");
    });

    it("ignores model-supplied company and filing when material is provided (Issue #83)", () => {
      for (const secUrl of ["javascript:alert(1)", "https://evil.example/x"]) {
        const rawLlmOutput = JSON.stringify({
          executiveSummary: "LLM summarized Q4 earnings.",
          keyDrivers: ["Growth in Cloud and Hardware."],
          company: { ticker: "EVIL", name: "Evil", cik: "9999999999" },
          filing: {
            form: "8-K",
            filingDate: "2099-01-01",
            secUrl,
            accessionNumber: "x",
          },
        });

        const res = parseEarningsDecoderOutput(
          rawLlmOutput,
          mockMaterial as unknown as ArtifactEventMaterial,
        );
        expect(res).not.toBeNull();
        expect(res?.filing.secUrl).toBe("https://sec.gov/filing/1");
        expect(res?.filing.form).toBe("10-K");
        expect(res?.company.cik).toBe("0000320193");
        expect(res?.company.ticker).toBe("AAPL");
      }
    });

    it("returns null on malformed JSON or empty string", () => {
      expect(parseEarningsDecoderOutput("")).toBeNull();
      expect(parseEarningsDecoderOutput("not valid json")).toBeNull();
    });

    it("returns null when metrics array is empty and no material metrics exist", () => {
      const noMetrics = {
        ...validPayload,
        metrics: [],
      };
      expect(parseEarningsDecoderOutput(JSON.stringify(noMetrics))).toBeNull();
    });
  });
});
