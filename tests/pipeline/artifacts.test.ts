import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { generateEventArtifacts } from "../../src/pipeline/artifacts/build";
import { enqueueDueArtifacts } from "../../src/pipeline/artifacts/schedule";
import { handleGenerateBatch } from "../../src/pipeline/generate/consumer";
import type { GenerateMessage, PipelineEnv } from "../../src/pipeline/messages";
import type { ModelTransport } from "../../src/providers/transport";

class FakeQueue {
  sent: GenerateMessage[] = [];
  async send(msg: GenerateMessage) {
    this.sent.push(msg);
  }
  async sendBatch(msgs: Iterable<{ body: GenerateMessage }>) {
    this.sent.push(...Array.from(msgs).map((m) => m.body));
  }
}

function makeFakeTransport(
  responder: (model: string, input: unknown) => unknown,
): ModelTransport {
  return {
    run: async (model, input) => {
      const resp = responder(model, input);
      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: typeof resp === "string" ? resp : JSON.stringify(resp),
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 100,
          totalTokenCount: 150,
        },
      };
    },
  };
}

function makeAllValidFakeTransport(): ModelTransport {
  return makeFakeTransport((_model, input) => {
    const s = JSON.stringify(input);
    if (s.includes("AI-in-Finance Reality Check") || s.includes("claimant")) {
      return {
        claimant: "Alpha Fund",
        claimSummary: "High alpha",
        claimType: "backtest",
        testPeriodAndBenchmark: "2020-2024",
        costsAndAssumptions: "Zero cost",
        disclosedCautions: ["Hypothetical"],
      };
    }
    if (s.includes("Regulation Watch") || s.includes("actionTitle")) {
      return {
        regulator: "SEC",
        actionTitle: "Inquiry",
        summary: "Summary",
        affectedInstitutions: ["Banks"],
        keyRequirements: ["Audit"],
        effectiveDate: "2026-11-01",
        enforcementContext: "Context",
      };
    }
    if (
      s.includes("Finance Concepts for Learners") ||
      s.includes("plainEnglishDefinition")
    ) {
      return {
        conceptName: "Liquidity",
        plainEnglishDefinition: "Ease of trading",
        applicationInStory: "Context",
        commonPitfalls: ["Pitfall"],
        keyTakeaways: ["Takeaway"],
      };
    }
    if (s.includes("workforce intelligence") || s.includes("industryShift")) {
      return {
        industryShift: "Shift",
        emergingSkills: ["Skill 1"],
        decliningOrAtRiskSkills: ["Skill 2"],
        affectedOccupations: [{ role: "Dev", impact: "Impact" }],
        trainingRecommendations: ["Train"],
      };
    }
    if (
      s.includes("cross-industry intelligence analyst") ||
      s.includes("Industry Impact Report") ||
      s.includes("affectedIndustries")
    ) {
      return {
        summary: "Cross-industry transmission overview",
        affectedIndustries: [
          {
            industry: "Semiconductors",
            impact: "Lead time expansion",
            transmissionPath: "Capacity shortage",
            basis: "speculative",
            citation: null,
          },
        ],
        affectedOccupations: [
          {
            role: "Silicon Architect",
            impact: "Toolchain updates",
            timeframe: "short_term",
            basis: "speculative",
            citation: null,
          },
        ],
        decisionImplications: [
          {
            decisionMaker: "Procurement",
            recommendationOrTradeoff: "Dual source",
            basis: "speculative",
            citation: null,
          },
        ],
      };
    }
    if (
      s.includes("supply chain modeling specialist") ||
      s.includes("Supply-Chain Ripple Map") ||
      s.includes("upstreamRipples")
    ) {
      return {
        focalNode: "Fab Expansion",
        upstreamRipples: [
          {
            target: "Optics",
            effect: "Lead times tighten",
            transmissionChannel: "Order pull-forward",
            isHypothesis: true,
            confidence: "high",
          },
        ],
        downstreamRipples: [
          {
            target: "Motherboard OEMs",
            effect: "Component allocations",
            transmissionChannel: "ASIC volume",
            isHypothesis: true,
            confidence: "medium",
          },
        ],
        keyHypotheses: ["Supplier buffer inventory is adequate."],
      };
    }
    if (s.includes("Policy Impact Explorer") || s.includes("policyName")) {
      return {
        policyName: "Policy",
        summary: "Summary",
        affectedAudiences: [{ group: "Group", impact: "Impact" }],
        timeline: [{ phase: "P1", milestone: "M1" }],
        remainingUncertainties: ["None"],
      };
    }
    if (
      s.includes("Classroom Discussion Builder") ||
      s.includes("pedagogical designer") ||
      s.includes("gradeLevels") ||
      s.includes("learningGoal")
    ) {
      return {
        topic: "Topic",
        gradeLevels: ["Grade 8"],
        discussionQuestions: [
          {
            question: "Discussion question?",
            learningGoal: "Critical thinking.",
          },
        ],
        classroomActivities: [
          { activity: "Socratic Seminar", instructions: "Split into pairs." },
        ],
      };
    }
    if (
      s.includes("empirical education research evaluator") ||
      s.includes("Education Evidence Checker") ||
      s.includes("claimedOutcomes")
    ) {
      return {
        subject: "Subject",
        claimedOutcomes: "Claim",
        measuredOutcomes: "Measured",
        studyDesign: {
          samplePopulation: "P",
          comparisonGroup: "C",
          metricUsed: "M",
        },
        promotionalGap: "Gap",
        limitations: ["Limitation"],
      };
    }
    if (s.includes("Research Paper Decoder")) {
      return {
        hypothesis: "Hypothesis",
        method: "Method",
        findings: "Findings",
        limitations: "Limitations",
        applications: "Applications",
      };
    }
    if (
      s.includes("interactive curriculum and learning materials designer") ||
      s.includes("conceptExplainer")
    ) {
      return {
        audience: s.includes("EDUCATOR")
          ? "educator"
          : s.includes("PROFESSIONAL")
            ? "professional"
            : "student",
        conceptExplainer: "Explainer",
        glossary: [{ term: "T", definition: "D" }],
        quiz: [
          {
            question: "Q",
            options: ["A", "B"],
            answerIndex: 0,
            explanation: "E",
          },
        ],
        discussionQuestions: ["D"],
        activities: ["A"],
      };
    }
    if (
      s.includes("expert educational writer") ||
      s.includes("keyPoints") ||
      s.includes("overview")
    ) {
      return {
        audience: s.includes("EDUCATOR")
          ? "educator"
          : s.includes("PROFESSIONAL")
            ? "professional"
            : "student",
        overview: "Overview of the verified event.",
        keyPoints: ["Key point 1."],
        implications: ["Practical implication 1."],
        glossary: [{ term: "T", definition: "D" }],
      };
    }
    return {
      whatHappened: "Standard event.",
      whatIsNew: "Novelty.",
      whatEvidenceExists: "Evidence.",
      whatToWatchNext: "Next.",
    };
  });
}

async function ensureBudget(day = "2026-10-24") {
  await env.DB.prepare(
    `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
     VALUES (?1, 'gateway', 10000000, 0, 0)
     ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
  )
    .bind(day)
    .run();
}

const testEnv: PipelineEnv = {
  ...env,
  MODEL_CALLS_ENABLED: "true",
};

describe("generateEventArtifacts", () => {
  it("skips generation when an event has no approved articles", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('art-skip-ind', 'Skip Ind', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Empty Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    let modelCalled = false;
    const transport: ModelTransport = {
      run: async () => {
        modelCalled = true;
        return { text: "{}", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("no_approved_articles");
    expect(modelCalled).toBe(false);
  });

  it("generates Story Brief for standard event (score >= select but < deep)", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 60 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: {
        deepThreshold: 75,
      },
    });

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('tech-brief-only', 'Tech Brief', 'auto', ?1, 1000) RETURNING id",
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://tech/feed', 'tech.io', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://tech/art-1', 'https://tech/art-1', 'Quantum Breakthrough', 'Summary of breakthrough', 'shaQuantum', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    // Approve the article
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaQuantum', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    // Analysis score 65 (>= select 60, but < deepThreshold 75)
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'product_launch', '[]', 65, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Quantum Breakthrough Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    let callsMade = 0;
    const transport = makeFakeTransport((_model, _input) => {
      callsMade++;
      return {
        whatHappened: "A new quantum circuit was verified.",
        whatIsNew: "Two-qubit gate fidelity reached 99.9%.",
        whatEvidenceExists: "Published benchmark tests on 50 samples.",
        whatToWatchNext: "Scaling to 100 qubits next quarter.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    expect(res.generatedCount).toBe(1); // Story Brief only
    expect(callsMade).toBe(1);

    // Verify row in event_artifacts
    const rows = await env.DB.prepare(
      "SELECT type, audience, input_revision, status, content FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{
        type: string;
        audience: string;
        input_revision: number;
        status: string;
        content: string;
      }>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].type).toBe("story_brief");
    expect(rows.results[0].audience).toBe("");
    expect(rows.results[0].input_revision).toBe(1);
    expect(rows.results[0].status).toBe("published"); // auto publish mode
    const brief = JSON.parse(rows.results[0].content);
    expect(brief.whatHappened).toBe("A new quantum circuit was verified.");
  });

  it("generates Story Brief and three-tier Explain for deep event (score >= deepThreshold)", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: {
        deepThreshold: 70,
      },
    });

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('edu-deep', 'Education Deep', 'review', ?1, 1000) RETURNING id",
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://edu/feed', 'edureview.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://edu/art-1', 'https://edu/art-1', 'AI in K12 Math Study', 'Large study on AI tutoring', 'shaEduMath', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaEduMath', 'approved', 'reviewer@ioenv.com', 1000)",
    )
      .bind(art!.id)
      .run();

    // High score 85 (>= 70)
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'research_study', '[]', 85, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'AI in K12 Math Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (inputStr.includes("Story Brief")) {
        return {
          whatHappened: "A nationwide K-12 math study was released.",
          whatIsNew: "First double-blind evaluation of generative tutors.",
          whatEvidenceExists: "Tested on 10,000 students over 12 months.",
          whatToWatchNext: "District adoption votes in autumn.",
        };
      }
      if (
        inputStr.toLowerCase().includes("learning materials") ||
        inputStr.includes("conceptExplainer")
      ) {
        return {
          audience: inputStr.includes("STUDENT")
            ? "student"
            : inputStr.includes("EDUCATOR")
              ? "educator"
              : "professional",
          conceptExplainer: "Adaptive math tutoring breakdown.",
          glossary: [{ term: "Tutor", definition: "Learning helper." }],
          quiz: [
            {
              question: "How does the tutor adapt?",
              options: ["Pacing", "Color"],
              answerIndex: 0,
              explanation: "Adjusts to pace.",
            },
          ],
          discussionQuestions: ["Will this increase equity?"],
          activities: ["Try 3 practice problems."],
        };
      }
      // Audience Explain
      if (inputStr.includes("STUDENT")) {
        return {
          audience: "student",
          overview: "Math tutors can now help you practice step by step.",
          keyPoints: ["Explains formulas simply", "Gives practice hints"],
          implications: ["Better algebra understanding"],
          glossary: [
            {
              term: "Adaptive tutor",
              definition:
                "A program that adjusts difficulty to your learning pace",
            },
          ],
        };
      }
      if (inputStr.includes("EDUCATOR")) {
        return {
          audience: "educator",
          overview:
            "Study shows effective integration with classroom instruction.",
          keyPoints: [
            "Frees up teacher time for 1-on-1 coaching",
            "Identifies misconception clusters",
          ],
          implications: ["Curriculum mapping needed"],
          glossary: [
            {
              term: "Formative diagnostic",
              definition:
                "Quick checks to see if students understand a concept",
            },
          ],
        };
      }
      // Professional
      return {
        audience: "professional",
        overview: "Rigorous longitudinal data on adaptive tutoring efficacy.",
        keyPoints: [
          "Effect size d=0.34 over baseline",
          "Reduced teacher grading load by 22%",
        ],
        implications: [
          "EdTech procurement standards will likely adopt these benchmarks",
        ],
        glossary: [
          {
            term: "Effect size",
            definition:
              "A statistical measurement of the strength of a relationship",
          },
        ],
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    // 1 Brief + 3 Audience Explains + 3 Learning Materials = 7 artifacts
    expect(res.generatedCount).toBe(7);

    const rows = await env.DB.prepare(
      "SELECT type, audience, status FROM event_artifacts WHERE event_id = ?1 ORDER BY type, audience",
    )
      .bind(event!.id)
      .all<{ type: string; audience: string; status: string }>();

    expect(rows.results).toHaveLength(7);
    // Review mode industry -> initial status is pending_review
    expect(rows.results.every((r) => r.status === "pending_review")).toBe(true);

    const audiences = rows.results
      .filter((r) => r.type === "audience_explain")
      .map((r) => r.audience);
    expect(audiences).toEqual(["educator", "professional", "student"]);
  });

  it("falls back deepThreshold to thresholds.select when artifacts.deepThreshold is not configured", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: [],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
    });

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('tech-fallback-deep', 'Tech Fallback Deep', 'auto', ?1, 1000) RETURNING id",
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://fallback/feed', 'fallback.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://fallback/art-1', 'https://fallback/art-1', 'Adaptive Learning Engine', 'Summary', 'shaFallback', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaFallback', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    // Score is 50, exactly equal to select threshold (50)
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'ctype', '[]', 50, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Fallback Deep Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (inputStr.includes("Story Brief")) {
        return {
          whatHappened: "Engine published.",
          whatIsNew: "Novel architecture.",
          whatEvidenceExists: "Benchmarks.",
          whatToWatchNext: "Adoption.",
        };
      }
      if (
        inputStr.toLowerCase().includes("learning materials") ||
        inputStr.includes("conceptExplainer")
      ) {
        return {
          audience: "student",
          conceptExplainer: "Adaptive tutor basics.",
          glossary: [{ term: "Tutor", definition: "Teaching agent." }],
          quiz: [
            {
              question: "How does it adapt?",
              options: ["Pacing", "Color"],
              answerIndex: 0,
              explanation: "Adjusts to pace.",
            },
          ],
          discussionQuestions: ["Will this help?"],
          activities: ["Try problems."],
        };
      }
      return {
        audience: "student",
        overview: "Overview.",
        keyPoints: ["Point 1"],
        implications: ["Implication 1"],
        glossary: [{ term: "Term", definition: "Def" }],
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    // Story Brief (1) + Audience Explains (3) + Learning Materials (3) = 7
    expect(res.generatedCount).toBe(7);
  });

  it("generates Research Paper Decoder for arXiv research paper events", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          research_paper: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: {
        deepThreshold: 60,
      },
    });

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('tech-arxiv', 'Tech Arxiv', 'auto', ?1, 1000) RETURNING id",
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://arxiv/feed', 'arxiv.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://arxiv.org/abs/2610.12345', 'https://arxiv.org/abs/2610.12345', 'Sparse Attention Bounds', 'Paper abstract', 'shaArxiv', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaArxiv', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'research_paper', '{"publication_status":"preprint"}', 88, 0.95, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Sparse Attention Paper Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (inputStr.includes("Story Brief")) {
        return {
          whatHappened: "Researchers proved linear attention bounds.",
          whatIsNew: "First tight mathematical bound for sparse attention.",
          whatEvidenceExists: "Theorem 1 and empirical validation on Wikitext.",
          whatToWatchNext: "Hardware acceleration implementations.",
        };
      }
      if (inputStr.includes("Research Paper Decoder")) {
        return {
          hypothesis:
            "Can quadratic attention be replaced with O(N) sparse patterns without quality degradation?",
          method: "Dynamic block-sparse attention mask with learned routing.",
          findings:
            "Matches dense attention perplexity within 0.05 while cutting latency by 4x.",
          limitations:
            "Tested only up to 64k context lengths; requires custom CUDA kernels.",
          applications: "Long-document reasoning and code synthesis agents.",
        };
      }
      if (
        inputStr.toLowerCase().includes("learning materials") ||
        inputStr.includes("conceptExplainer")
      ) {
        return {
          audience: inputStr.includes("STUDENT")
            ? "student"
            : inputStr.includes("EDUCATOR")
              ? "educator"
              : "professional",
          conceptExplainer: "Sparse attention mechanisms explained.",
          glossary: [
            { term: "Sparsity", definition: "Skipping unnecessary tokens." },
          ],
          quiz: [
            {
              question: "What is the speed advantage?",
              options: ["4x latency cut", "No improvement"],
              answerIndex: 0,
              explanation: "Reduces quadratic cost to linear.",
            },
          ],
          discussionQuestions: ["Where is memory bound vs compute bound?"],
          activities: ["Benchmark token attention masks."],
        };
      }
      // Audience explain
      return {
        audience: "student",
        overview: "A new math technique makes AI remember longer documents.",
        keyPoints: ["Attention is now faster"],
        implications: ["Can read books in seconds"],
        glossary: [
          {
            term: "Attention",
            definition: "How models focus on relevant words",
          },
        ],
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    // 1 Brief + 3 Explain + 3 Learning Material + 1 Decoder = 8 artifacts
    expect(res.generatedCount).toBe(8);

    const decoderRow = await env.DB.prepare(
      "SELECT type, status, content FROM event_artifacts WHERE event_id = ?1 AND type = 'research_paper_decoder'",
    )
      .bind(event!.id)
      .first<{ type: string; status: string; content: string }>();

    expect(decoderRow).toBeDefined();
    expect(decoderRow?.status).toBe("published"); // auto mode
    const dec = JSON.parse(decoderRow!.content);
    expect(dec.hypothesis).toContain("quadratic attention");
    expect(dec.method).toContain("block-sparse");
  });

  it("generates Research Paper Decoder solely based on preprint evidence tag when source is not arxiv and type is not research_paper", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          news_article: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["publication_status"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: {
        deepThreshold: 60,
      },
    });

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('tech-preprint-tag', 'Tech Preprint Tag', 'auto', ?1, 1000) RETURNING id",
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://nature.com/feed', 'nature.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://nature.com/articles/bio-preprint', 'https://nature.com/articles/bio-preprint', 'Genomics Early Findings', 'Bio report', 'shaNaturePreprint', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaNaturePreprint', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    // Source domain is nature.com (not arxiv), content_type is 'news_article' (not research_paper),
    // and evidence_tags has publication_status: preprint
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'news_article', '{"publication_status":"preprint"}', 80, 0.95, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Genomics Preprint Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (inputStr.includes("Story Brief")) {
        return {
          whatHappened: "Early genomics preprint published.",
          whatIsNew: "Novel gene editing pathway.",
          whatEvidenceExists: "In-vitro assays.",
          whatToWatchNext: "Animal trials.",
        };
      }
      if (inputStr.includes("Research Paper Decoder")) {
        return {
          hypothesis: "Can base editing improve target specificity?",
          method: "CRISPR-Cas guided base deaminase.",
          findings: "Reduces off-target edits by 90%.",
          limitations: "Tested only in cell culture.",
          applications: "Monogenic disease therapies.",
        };
      }
      if (
        inputStr.toLowerCase().includes("learning materials") ||
        inputStr.includes("conceptExplainer")
      ) {
        return {
          audience: "student",
          conceptExplainer: "Gene editing basics.",
          glossary: [{ term: "CRISPR", definition: "Molecular scissors." }],
          quiz: [
            {
              question: "What does it edit?",
              options: ["DNA", "Sugar"],
              answerIndex: 0,
              explanation: "Edits genomic sequence.",
            },
          ],
          discussionQuestions: ["Ethics of gene therapy."],
          activities: ["Model base pairing."],
        };
      }
      return {
        audience: "student",
        overview: "Overview.",
        keyPoints: ["Point 1"],
        implications: ["Implication 1"],
        glossary: [{ term: "CRISPR", definition: "Molecular scissors." }],
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const decoderRow = await env.DB.prepare(
      "SELECT type, status, content FROM event_artifacts WHERE event_id = ?1 AND type = 'research_paper_decoder'",
    )
      .bind(event!.id)
      .first<{ type: string; status: string; content: string }>();

    expect(decoderRow).not.toBeNull();
    expect(decoderRow?.type).toBe("research_paper_decoder");
    expect(decoderRow?.status).toBe("published");
  });

  it("protects against revision race conditions (stale revision does not insert)", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: {
        deepThreshold: 80,
      },
    });

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('race-ind', 'Race Ind', 'auto', ?1, 1000) RETURNING id",
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://race/feed', 'race.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://race/art-1', 'https://race/art-1', 'Race Story', 'Summary', 'shaRace', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaRace', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'ctype', '[]', 60, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Race Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    // Transport simulates a concurrent revision bump during LLM execution:
    // revision moves from 1 to 2 while model is generating.
    const transport = makeFakeTransport((_model, _input) => {
      // Synchronously bump revision in DB to simulate concurrent review / retraction
      env.DB.prepare("UPDATE events SET revision = 2 WHERE id = ?1")
        .bind(event!.id)
        .run();
      return {
        whatHappened:
          "Stale brief that should be rejected by conditional insert.",
        whatIsNew: "Should not land in DB.",
        whatEvidenceExists: "None.",
        whatToWatchNext: "None.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.generatedCount).toBe(0);

    // Verify 0 rows inserted into event_artifacts
    const rows = await env.DB.prepare(
      "SELECT id FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all();
    expect(rows.results).toHaveLength(0);
  });

  it("enforces Finance section guardrails (status is pending_review)", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: {
        deepThreshold: 80,
      },
    });

    // Finance section slug is 'finance'
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('finance', 'Finance', 'auto', ?1, 1000) RETURNING id",
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://fin/feed', 'sec.gov', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://fin/art-1', 'https://fin/art-1', 'Bank AI Report', 'Summary', 'shaFin', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaFin', 'approved', 'compliance@ioenv.com', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'ctype', '[]', 55, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Finance Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (
        inputStr.toLowerCase().includes("financial literacy") ||
        inputStr.includes("conceptName")
      ) {
        return {
          conceptName: "Commercial Bank Reserves",
          plainEnglishDefinition: "Funds held to meet regulatory requirements.",
          applicationInStory:
            "Report shows how automated systems optimize liquidity.",
          commonPitfalls: ["Banks only hold physical currency."],
          keyTakeaways: ["Liquidity management is key to stability."],
        };
      }
      return {
        whatHappened: "Bank reported AI backtesting results.",
        whatIsNew: "First reported deployment on commodities trading.",
        whatEvidenceExists: "SEC 8-K filing item 2.02.",
        whatToWatchNext: "Next quarterly audit.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type, status FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string; status: string }>();

    expect(rows.results.length).toBeGreaterThanOrEqual(1);
    // Mandatory Finance review rule: ALL artifact rows must be pending_review!
    expect(rows.results.every((r) => r.status === "pending_review")).toBe(true);
  });

  it("is idempotent: repeated invocation on same event and revision makes zero duplicate calls", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: {
        deepThreshold: 80,
      },
    });

    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('idemp-ind', 'Idemp Ind', 'auto', ?1, 1000) RETURNING id",
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://idemp/feed', 'idemp.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://idemp/art-1', 'https://idemp/art-1', 'Idemp Story', 'Summary', 'shaIdemp', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaIdemp', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'ctype', '[]', 55, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Idemp Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    let callCount = 0;
    const transport = makeFakeTransport((_model, _input) => {
      callCount++;
      return {
        whatHappened: "First brief.",
        whatIsNew: "Novelty.",
        whatEvidenceExists: "Evidence.",
        whatToWatchNext: "Next steps.",
      };
    });

    // Run 1: generates
    const res1 = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res1.status).toBe("generated");
    expect(callCount).toBe(1);

    // Run 2: skips without model calls
    const res2 = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res2.status).toBe("already_up_to_date");
    expect(callCount).toBe(1);
  });
});

describe("enqueueDueArtifacts & handleGenerateBatch", () => {
  it("enqueues events with approved articles missing story_brief", async () => {
    const queue = new FakeQueue();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('sched-art-ind', 'Sched Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://sched/feed', 'sched.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://sched/art-1', 'https://sched/art-1', 'Sched Story', 'Summary', 'shaSched', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaSched', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Sched Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const pipelineEnv = {
      DB: env.DB,
      Q_GENERATE: queue as unknown as Queue,
    };

    const enqueued = await enqueueDueArtifacts(pipelineEnv, 1000);
    expect(enqueued).toContain(event!.id);
    expect(queue.sent).toContainEqual({
      kind: "artifacts",
      eventId: event!.id,
    });
  });

  it("handles artifacts message in handleGenerateBatch", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('batch-art-ind', 'Batch Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://batch/feed', 'batch.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://batch/art-1', 'https://batch/art-1', 'Batch Story', 'Summary', 'shaBatch', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaBatch', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Batch Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, _input) => ({
      whatHappened: "Batch brief happened.",
      whatIsNew: "Batch novelty.",
      whatEvidenceExists: "Batch evidence.",
      whatToWatchNext: "Batch next.",
    }));

    let acked = false;
    const msg: Message<GenerateMessage> = {
      id: "msg-1",
      timestamp: new Date(),
      body: { kind: "artifacts", eventId: event!.id },
      attempts: 1,
      ack: () => {
        acked = true;
      },
      retry: () => {},
    };

    const batch: MessageBatch<GenerateMessage> = {
      queue: "ainews-generate",
      messages: [msg],
      metadata: {} as unknown as MessageBatchMetadata,
      ackAll: () => {},
      retryAll: () => {},
    };

    await handleGenerateBatch(batch, testEnv, { transport });
    expect(acked).toBe(true);

    const row = await env.DB.prepare(
      "SELECT id FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .first<{ id: number }>();
    expect(row).toBeDefined();
  });

  it("uses article title and summary overrides in generated prompt material", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('override-ind', 'Override Industry', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://test/feed', 'test.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, title_override, summary_override, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test/override', 'https://test/override', 'Original Title', 'Original Summary', 'Hand-Crafted Override Title', 'Hand-Crafted Override Summary', 'shaOver', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaOver', 'approved', 'human', 1000)",
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Original Event Title', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    let capturedPrompt = "";
    const transport = makeFakeTransport((_model, input) => {
      capturedPrompt = JSON.stringify(input);
      return {
        whatHappened: "Verified override happened.",
        whatIsNew: "Novel override.",
        whatEvidenceExists: "Evidence exists.",
        whatToWatchNext: "Watch next.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    expect(capturedPrompt).toContain("Hand-Crafted Override Title");
    expect(capturedPrompt).toContain("Hand-Crafted Override Summary");
    expect(capturedPrompt).not.toContain("Original Title");
  });

  it("generates Story Brief even when article score is below selectThreshold", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES ('low-ind', 'Low Score Industry', 'review', '{\"thresholds\":{\"select\":70}}', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://test/low', 'test.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test/low-score', 'https://test/low-score', 'Low Score Article', 'Low summary', 'shaLow', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaLow', 'approved', 'human', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'news', '{}', 35, 0.9, 1, 'cat', 'none', 0, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Low Score Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, _input) => ({
      whatHappened: "Low score event brief.",
      whatIsNew: "Novelty.",
      whatEvidenceExists: "Evidence.",
      whatToWatchNext: "Next.",
    }));

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    expect(res.generatedCount).toBe(1);
  });

  it("generates Education editorial products when matching keywords in education sector", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: {
        deepThreshold: 90,
      },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('education', 'Education', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://ed/feed-pol', 'ed.gov', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art1 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://ed/art-policy', 'https://ed/art-policy', 'Department of Education AI Policy Directives', 'A comprehensive legislative mandate for classroom AI.', 'shaEduPol', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    const art2 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://ed/art-study', 'https://ed/art-study', 'Classroom Trial Empirical Results', 'A peer-reviewed trial evaluating teacher pedagogy and outcomes.', 'shaEduStudy', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaEduPol', 'approved', 'auto', 1000), (?2, 'shaEduStudy', 'approved', 'auto', 1000)",
    )
      .bind(art1!.id, art2!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'policy_change', '["regulatory_finding"]', 65, 0.9, 1, 'cat', 'none', 1, 1000),
              (?2, 'pv1', '{}', 'research_study', '["peer_reviewed"]', 68, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art1!.id, art2!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Education Policy & Study Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000), (?1, ?3, 1000)",
    )
      .bind(event!.id, art1!.id, art2!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (
        inputStr.toLowerCase().includes("policy analysis") ||
        inputStr.includes("affectedAudiences")
      ) {
        return {
          policyName: "Federal K-12 AI Directives",
          summary: "New policy framework for automated tutoring.",
          affectedAudiences: [
            { group: "Teachers", impact: "Mandatory training" },
          ],
          timeline: [{ phase: "Phase 1", milestone: "Guideline publication" }],
          remainingUncertainties: ["State adoption variance"],
        };
      }
      if (
        inputStr.toLowerCase().includes("pedagogical facilitation") ||
        inputStr.includes("classroomActivities")
      ) {
        return {
          topic: "Classroom AI Ethics",
          gradeLevels: ["Middle School", "High School"],
          discussionQuestions: [
            {
              question: "Should AI write essays?",
              learningGoal: "Explore authenticity",
            },
          ],
          classroomActivities: [
            { activity: "Debate", instructions: "Split into 2 teams" },
          ],
        };
      }
      if (
        inputStr
          .toLowerCase()
          .includes("promotional claims vs. empirical outcomes") ||
        inputStr.includes("claimedOutcomes")
      ) {
        return {
          subject: "AI Literacy Program",
          claimedOutcomes: "Triples test scores",
          measuredOutcomes: "Modest 5% improvement",
          studyDesign: {
            samplePopulation: "50 students",
            comparisonGroup: "Historical cohort",
            metricUsed: "State test",
          },
          promotionalGap: "Vendor selective reporting",
          limitations: ["Small sample size"],
        };
      }
      return {
        whatHappened: "Education policy study announced.",
        whatIsNew: "Federal guidelines established.",
        whatEvidenceExists: "Empirical trial on 50 classrooms.",
        whatToWatchNext: "Next semester rollouts.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    // Story brief + 3 Education products = 4 artifacts
    expect(res.generatedCount).toBe(4);

    const rows = await env.DB.prepare(
      "SELECT type, status FROM event_artifacts WHERE event_id = ?1 ORDER BY type",
    )
      .bind(event!.id)
      .all<{ type: string; status: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("policy_impact_explorer");
    expect(types).toContain("classroom_discussion_builder");
    expect(types).toContain("education_evidence_checker");
  });

  it("generates Policy Impact Explorer solely based on regulatory_finding tag for sub-deep event", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          curriculum_report: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["development_stage"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('education', 'Education', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://ed/sub-deep', 'ed.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://ed/art-reg-finding', 'https://ed/art-reg-finding', 'State Board Ruling on AI Assessment', 'A formal ruling on student data privacy.', 'shaRegRuling', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaRegRuling', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    // Score is 65 (>= select 50, but < deepThreshold 90)
    // content_type is 'curriculum_report' (not 'policy_change')
    // evidence_tags contains regulatory_finding
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'curriculum_report', '{"development_stage":"regulatory_finding"}', 65, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Assessment Board Ruling Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (
        inputStr.toLowerCase().includes("policy analysis") ||
        inputStr.includes("affectedAudiences")
      ) {
        return {
          policyName: "State AI Assessment Ruling",
          summary: "Ruling limits third-party grading tools without consent.",
          affectedAudiences: [
            { group: "School Districts", impact: "Audit current contracts" },
          ],
          timeline: [{ phase: "Immediate", milestone: "Compliance review" }],
          remainingUncertainties: ["Federal preemption questions"],
        };
      }
      if (
        inputStr.toLowerCase().includes("pedagogical facilitation") ||
        inputStr.includes("classroomActivities")
      ) {
        return {
          topic: "AI Assessment Governance",
          gradeLevels: ["High School"],
          discussionQuestions: [
            {
              theme: "Data Rights",
              prompt: "Should students own test data?",
            },
          ],
          classroomActivities: [
            {
              title: "Draft an Assessment Policy",
              procedure: "Group mock debate.",
            },
          ],
        };
      }
      return {
        whatHappened: "Board issued ruling on assessment AI.",
        whatIsNew: "Explicit consent requirements.",
        whatEvidenceExists: "Official hearing transcript.",
        whatToWatchNext: "District adoption timeline.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const policyRow = await env.DB.prepare(
      "SELECT type, status, content FROM event_artifacts WHERE event_id = ?1 AND type = 'policy_impact_explorer'",
    )
      .bind(event!.id)
      .first<{ type: string; status: string; content: string }>();

    expect(policyRow).not.toBeNull();
    expect(policyRow?.type).toBe("policy_impact_explorer");
    expect(policyRow?.status).toBe("published");
  });

  it("never generates Education editorial products in non-education sectors even with matching keywords and evidence", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    // Technology industry
    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('technology', 'Technology', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://tech/feed-pol', 'tech.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    // Article 1: matches policy_impact_explorer and classroom_discussion_builder criteria
    const art1 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://tech/art-edu-words', 'https://tech/art-edu-words', 'Department of Education AI Policy Cloud Infrastructure', 'Cloud servers handling student classroom data.', 'shaTechEdu', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaTechEdu', 'approved', 'auto', 1000)",
    )
      .bind(art1!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'policy_change', '["policy", "classroom"]', 95, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art1!.id)
      .run();

    // Article 2: matches education_evidence_checker criteria
    const art2 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://tech/art-edu-study', 'https://tech/art-edu-study', 'Empirical Study on AI Tutor Outcomes', 'Randomized trial on math learning.', 'shaTechStudy', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaTechStudy', 'approved', 'auto', 1000)",
    )
      .bind(art2!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'research_study', '["peer_reviewed", "test_scores"]', 95, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art2!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Tech Cloud Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art1!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art2!.id)
      .run();

    const transport = makeAllValidFakeTransport();

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("learning_material");
    expect(types).not.toContain("policy_impact_explorer");
    expect(types).not.toContain("classroom_discussion_builder");
    expect(types).not.toContain("education_evidence_checker");
  });

  it("generates Finance editorial products, enforces pending_review, and prevents cross-sector leakage", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    // Finance industry with auto publish mode
    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('finance', 'Finance', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://fin/feed-all', 'sec.gov', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    // Article with keywords matching backtest, sec, and liquidity
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://fin/art-all', 'https://fin/art-all', 'Hedge Fund AI Backtest Model Faces SEC Audit Over Liquidity Risk', 'Trading model claimed high alpha but SEC examines margin requirements.', 'shaFinAll', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaFinAll', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'regulatory_action', '["backtest", "regulatory_finding"]', 65, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Hedge Fund SEC Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (
        inputStr.toLowerCase().includes("reality check") ||
        inputStr.includes("testPeriodAndBenchmark")
      ) {
        return {
          claimant: "Alpha Fund",
          claimSummary: "Model yields 25% returns",
          claimType: "backtest",
          testPeriodAndBenchmark: "2020-2024 vs S&P 500",
          costsAndAssumptions: "Zero transaction fees",
          disclosedCautions: ["Severe drawdowns in illiquid assets"],
        };
      }
      if (
        inputStr.toLowerCase().includes("regulatory compliance intelligence") ||
        inputStr.includes("actionTitle")
      ) {
        return {
          regulator: "SEC",
          actionTitle: "Inquiry into Model Risk Management",
          summary: "Examining AI model assumptions.",
          affectedInstitutions: ["Registered Hedge Funds"],
          keyRequirements: ["Disclose data provenance and validation"],
          effectiveDate: "Immediate",
          enforcementContext: "Section 206 of Advisers Act",
        };
      }
      if (
        inputStr.toLowerCase().includes("financial literacy") ||
        inputStr.includes("conceptName")
      ) {
        return {
          conceptName: "Liquidity Risk in Algorithmic Trading",
          plainEnglishDefinition:
            "The risk that you cannot sell an asset quickly without taking a massive loss.",
          applicationInStory:
            "The model assumed endless buyers even during sudden sell-offs.",
          commonPitfalls: ["Confusing trading volume with market liquidity"],
          keyTakeaways: ["Always model transaction slippage"],
        };
      }
      return {
        whatHappened: "SEC opened inquiry into hedge fund AI model.",
        whatIsNew: "First formal algorithmic probe.",
        whatEvidenceExists: "Formal inquiry letters.",
        whatToWatchNext: "Hearing schedule.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    // Story brief + 3 Finance products = 4 artifacts
    expect(res.generatedCount).toBe(4);

    const rows = await env.DB.prepare(
      "SELECT type, status FROM event_artifacts WHERE event_id = ?1 ORDER BY type",
    )
      .bind(event!.id)
      .all<{ type: string; status: string }>();

    expect(rows.results).toHaveLength(4);
    // CRITICAL SECURITY GUARDRAIL: Even with publish_mode='auto', EVERY Finance artifact MUST BE pending_review!
    expect(rows.results.every((r) => r.status === "pending_review")).toBe(true);

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("finance_reality_check");
    expect(types).toContain("regulation_watch");
    expect(types).toContain("finance_concept_explainer");
  });

  it("generates Skills and Career Trends in industry sector and prevents leakage into education", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    // Industry sector
    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('industry', 'Industry', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://ind/feed-car', 'industry.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://ind/art-career', 'https://ind/art-career', 'Tech Workforce Automation Reshapes Software Engineering Skills and Salary Trends', 'Major hiring and reskilling shifts across software roles.', 'shaIndCar', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaIndCar', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'market_trend', '[]', 65, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Tech Hiring Trends Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (
        inputStr.toLowerCase().includes("workforce & occupational evolution") ||
        inputStr.includes("emergingSkills")
      ) {
        return {
          industryShift:
            "Widespread AI agent adoption in enterprise codebase maintenance.",
          emergingSkills: ["Agent orchestration", "System verification evals"],
          decliningOrAtRiskSkills: ["Boilerplate CRUD drafting"],
          affectedOccupations: [
            {
              role: "Junior Developer",
              impact: "Shift towards evaluation and code review",
            },
          ],
          trainingRecommendations: [
            "Master prompt and agent test harness design",
          ],
        };
      }
      return {
        whatHappened: "Industry hiring survey published.",
        whatIsNew: "Rapid growth in AI agent orchestration skills.",
        whatEvidenceExists: "Survey of 500 engineering directors.",
        whatToWatchNext: "Upcoming compensation surveys.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");
    // Story brief + SkillsCareerTrends = 2 artifacts
    expect(res.generatedCount).toBe(2);

    const rows = await env.DB.prepare(
      "SELECT type, status FROM event_artifacts WHERE event_id = ?1 ORDER BY type",
    )
      .bind(event!.id)
      .all<{ type: string; status: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("skills_career_trends");
  });

  it("never generates Finance products in non-finance sectors even if article has finance tags", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('technology', 'Technology', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://tech/feed-fin', 'tech.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://tech/art-fin-claim', 'https://tech/art-fin-claim', 'AI Backtest Performance in Cloud Deployments', 'Summary', 'shaTechFin', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaTechFin', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'backtest_result', '["backtest", "regulation", "sec"]', 95, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Tech Finance Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeAllValidFakeTransport();

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("learning_material");
    expect(types).not.toContain("finance_reality_check");
    expect(types).not.toContain("regulation_watch");
    expect(types).not.toContain("finance_concept_explainer");
  });

  it("does not generate Finance reality check or regulation watch when content type and tags do not match even if eventScore >= deepThreshold", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('finance', 'Finance', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://fin/feed-unmatch', 'bank.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://fin/art-unmatched', 'https://fin/art-unmatched', 'General Macroeconomic Outlook Commentary', 'Summary', 'shaFinUnmatch', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaFinUnmatch', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    // General news, no backtest or regulatory finding, but high score >= deepThreshold
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'macro_commentary', '[]', 95, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Macro Commentary Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeAllValidFakeTransport();

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("learning_material");
    expect(types).toContain("finance_concept_explainer");
    expect(types).not.toContain("finance_reality_check");
    expect(types).not.toContain("regulation_watch");
  });

  it("never generates Skills and Career Trends in non-industry sectors even with market_trend type", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('technology', 'Technology', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://tech/feed-trend', 'tech.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://tech/art-tech-trend', 'https://tech/art-tech-trend', 'Tech Software Market Trend Survey', 'Summary', 'shaTechTrend', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaTechTrend', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'market_trend', '["workforce"]', 95, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Tech Market Trend Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeAllValidFakeTransport();

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("learning_material");
    expect(types).not.toContain("skills_career_trends");
  });

  it("does not generate Skills and Career Trends in industry sector when content type is not market_trend or company_move even if eventScore >= deepThreshold", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('industry', 'Industry', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://ind/feed-unmatched', 'industry.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://ind/art-tutorial', 'https://ind/art-tutorial', 'General Software Tutorial', 'Summary', 'shaIndTut', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaIndTut', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'tutorial_guide', '[]', 95, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Software Tutorial Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeAllValidFakeTransport();

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("learning_material");
    expect(types).not.toContain("skills_career_trends");
  });

  it("does not generate Education policy or evidence products when content type and tags do not match even if eventScore >= deepThreshold", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('education', 'Education', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://ed/feed-unmatch', 'ed.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://ed/art-unmatched', 'https://ed/art-unmatched', 'Student Reflection Essay on Campus Life', 'Summary', 'shaEdEssay', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaEdEssay', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'student_reflection', '[]', 95, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Campus Life Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeAllValidFakeTransport();

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("learning_material");
    expect(types).toContain("classroom_discussion_builder");
    expect(types).not.toContain("policy_impact_explorer");
    expect(types).not.toContain("education_evidence_checker");
  });

  it("handles malformed JSON and schema mismatches gracefully without crashing the pipeline", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          ctype: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["safety"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('education', 'Education Resilience', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://ed/fail-feed', 'ed.org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://ed/fail-art', 'https://ed/fail-art', 'Department of Education AI Policy Draft', 'Legislative draft on AI.', 'shaEduFail', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaEduFail', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'policy_change', '["policy"]', 65, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Fail Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    // Transport returns invalid JSON for policy explorer, but valid Story Brief
    const transport = makeFakeTransport((_model, input) => {
      const inputStr = JSON.stringify(input);
      if (inputStr.toLowerCase().includes("policy analysis")) {
        return "MALFORMED_NON_JSON_CONTENT{{{";
      }
      return {
        whatHappened: "Resilience event happened.",
        whatIsNew: "Novelty test.",
        whatEvidenceExists: "Evidence exists.",
        whatToWatchNext: "Next steps.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    // Pipeline does not throw; generated valid brief and skipped malformed artifacts
    expect(res.status).toBe("generated");
    expect(res.generatedCount).toBe(1); // Story brief succeeded; others with mismatched schema skipped

    const rows = await env.DB.prepare(
      "SELECT type FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).not.toContain("policy_impact_explorer");
  });

  it("generates industry_impact_report and supply_chain_ripple_map for Industry vertical events (Issue #21)", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          market_trend: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["supply_chain"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('industry', 'Industrial Supply & Tech', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://industry.test/feed', 'industry.test', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://industry.test/fab-expansion', 'https://industry.test/fab-expansion', 'Foundry Expands Advanced Node Fab Capacity', 'Summary of fab expansion.', 'shaFabExp', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaFabExp', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'market_trend', '["supply_chain"]', 85, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Fab Expansion Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    // Insert a verified claim for this event and revision
    const claim = await env.DB.prepare(
      `INSERT INTO claims (event_id, claim_text, claim_type, consensus_status, primary_source_preferred, status, input_revision, prompt_version, model, created_at)
       VALUES (?1, 'Foundry commits $12B to advanced packaging expansion.', 'fact', 'verified', 0, 'published', 1, 'claims-v1', 'mock-model', 1000)
       RETURNING id`,
    )
      .bind(event!.id)
      .first<{ id: number }>();

    // Custom transport returning verified claim citation
    const transport = makeFakeTransport((_model, input) => {
      const s = JSON.stringify(input);
      if (
        s.includes("Industry Impact Report") ||
        s.includes("affectedIndustries")
      ) {
        return {
          summary: "Foundry expansion alters packaging landscape.",
          affectedIndustries: [
            {
              industry: "Advanced Packaging",
              impact: "Lead time buffer contracts.",
              transmissionPath: "Capacity absorption.",
              basis: "evidence_based",
              citation: {
                claimId: claim!.id,
                quote: "Foundry commits $12B to advanced packaging expansion.",
              },
            },
          ],
          affectedOccupations: [
            {
              role: "Substrate Layout Specialist",
              impact: "Toolchain updates required.",
              timeframe: "immediate",
              basis: "evidence_based",
              citation: { claimId: claim!.id },
            },
          ],
          decisionImplications: [
            {
              decisionMaker: "Procurement VP",
              recommendationOrTradeoff: "Pre-book substrate volume.",
              basis: "speculative",
              citation: null,
            },
          ],
        };
      }
      if (
        s.includes("Supply-Chain Ripple Map") ||
        s.includes("upstreamRipples")
      ) {
        return {
          focalNode: "Foundry 3nm expansion",
          upstreamRipples: [
            {
              target: "EUV Optics",
              effect: "High-NA mirrors delivery accelerates.",
              transmissionChannel: "Order pull-forward.",
              isHypothesis: true,
              confidence: "high",
            },
          ],
          downstreamRipples: [
            {
              target: "Hyperscale Server Motherboards",
              effect: "Component allocation constraints.",
              transmissionChannel: "High ASIC run-rate.",
              isHypothesis: true,
              confidence: "medium",
            },
          ],
          keyHypotheses: ["Supplier yield reaches 85% by Q3."],
        };
      }
      return {
        whatHappened: "Fab expansion happened.",
        whatIsNew: "New fab node.",
        whatEvidenceExists: "Evidence exists.",
        whatToWatchNext: "Next milestones.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type, content FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string; content: string }>();

    const types = rows.results.map((r) => r.type);
    expect(types).toContain("story_brief");
    expect(types).toContain("industry_impact_report");
    expect(types).toContain("supply_chain_ripple_map");

    // Verify stored content
    const impactRow = rows.results.find(
      (r) => r.type === "industry_impact_report",
    );
    expect(impactRow).toBeDefined();
    const parsedImpact = JSON.parse(impactRow!.content);
    expect(parsedImpact.affectedIndustries[0].basis).toBe("evidence_based");
    expect(parsedImpact.affectedIndustries[0].citation.claimId).toBe(claim!.id);

    const rippleRow = rows.results.find(
      (r) => r.type === "supply_chain_ripple_map",
    );
    expect(rippleRow).toBeDefined();
    const parsedRipple = JSON.parse(rippleRow!.content);
    expect(parsedRipple.upstreamRipples[0].isHypothesis).toBe(true);
    expect(parsedRipple.downstreamRipples[0].isHypothesis).toBe(true);
  });

  it("M3 mutation test: isolates supply_chain_ripple_map to Industry vertical only", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          market_trend: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["supply_chain"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    // Technology vertical
    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('technology', 'Technology', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://tech.test/feed', 'tech.test', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://tech.test/article', 'https://tech.test/article', 'Tech Fab Article', 'Summary.', 'shaTechFab', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaTechFab', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'market_trend', '["supply_chain"]', 95, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Tech Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const transport = makeAllValidFakeTransport();
    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const rows = await env.DB.prepare(
      "SELECT type FROM event_artifacts WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ type: string }>();

    const types = rows.results.map((r) => r.type);
    // supply_chain_ripple_map MUST NOT be generated for technology vertical
    expect(types).not.toContain("supply_chain_ripple_map");
    // Cross-vertical industry_impact_report IS generated for deep events (95 >= 90)
    expect(types).toContain("industry_impact_report");
  });

  it("M4 mutation test: automatically downgrades phantom claim citations to speculative in pipeline", async () => {
    await ensureBudget();
    const config = JSON.stringify({
      analysis: {
        prefilter: { relevant: "r", off_topic: "o", noise: "n" },
        categories: { cat: "desc" },
        contentTypes: {
          market_trend: {
            description: "d",
            weights: { sig: 1, nov: 1, cred: 1, reson: 1, act: 1 },
          },
        },
        dimensions: {
          sig: ["s1", "s2", "s3", "s4", "s5"],
          nov: ["n1", "n2", "n3", "n4", "n5"],
        },
        labels: ["supply_chain"],
        thresholds: { prefilterMinRelevant: 0.3, select: 50 },
        summaryGuidance: "g",
        guardrails: [],
      },
      artifacts: { deepThreshold: 90 },
    });

    const ind = await env.DB.prepare(
      `INSERT INTO industries (slug, name, publish_mode, config, created_at)
       VALUES ('industry', 'Industrial Supply & Tech', 'auto', ?1, 1000)
       ON CONFLICT (slug) DO UPDATE SET config = ?1, publish_mode = 'auto'
       RETURNING id`,
    )
      .bind(config)
      .first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://industry.test/feed2', 'industry.test', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://industry.test/art2', 'https://industry.test/art2', 'Industry News 2', 'Summary.', 'shaInd2', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaInd2', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'market_trend', '["supply_chain"]', 80, 0.9, 1, 'cat', 'none', 1, 1000)`,
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Phantom Claim Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    // Transport outputs claimId: 88888 (phantom citation not in DB)
    const transport = makeFakeTransport((_model, input) => {
      const s = JSON.stringify(input);
      if (
        s.includes("Industry Impact Report") ||
        s.includes("affectedIndustries")
      ) {
        return {
          summary: "Phantom citation test.",
          affectedIndustries: [
            {
              industry: "Advanced Packaging",
              impact: "Lead time buffer contracts.",
              transmissionPath: "Capacity absorption.",
              basis: "evidence_based",
              citation: {
                claimId: 88888, // Phantom claimId!
              },
            },
          ],
          affectedOccupations: [
            {
              role: "Substrate Specialist",
              impact: "Toolchain updates required.",
              timeframe: "immediate",
              basis: "evidence_based",
              citation: { claimId: 88888 },
            },
          ],
          decisionImplications: [
            {
              decisionMaker: "Procurement VP",
              recommendationOrTradeoff: "Pre-book substrate volume.",
              basis: "speculative",
              citation: null,
            },
          ],
        };
      }
      return {
        whatHappened: "Event happened.",
        whatIsNew: "Novelty.",
        whatEvidenceExists: "Evidence exists.",
        whatToWatchNext: "Next.",
      };
    });

    const res = await generateEventArtifacts(testEnv, event!.id, 1000, {
      transport,
    });
    expect(res.status).toBe("generated");

    const row = await env.DB.prepare(
      "SELECT content FROM event_artifacts WHERE event_id = ?1 AND type = 'industry_impact_report'",
    )
      .bind(event!.id)
      .first<{ content: string }>();

    expect(row).toBeDefined();
    const stored = JSON.parse(row!.content);
    // Phantom claim citations must be safely downgraded to speculative and citation cleared
    expect(stored.affectedIndustries[0].basis).toBe("speculative");
    expect(stored.affectedIndustries[0].citation).toBeNull();
    expect(stored.affectedOccupations[0].basis).toBe("speculative");
    expect(stored.affectedOccupations[0].citation).toBeNull();
  });
});
