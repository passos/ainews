import { describe, expect, it } from "vitest";
import {
  NOT_STATED_IN_SOURCES,
  launchRealityCheckSchema,
  technologyEvolutionTimelineSchema,
} from "../../src/lib/artifacts/types";
import {
  buildEvolutionTimelineRequest,
  buildLaunchRealityCheckRequest,
  parseEvolutionTimelineOutput,
  parseLaunchRealityCheckOutput,
  type ArtifactEventMaterial,
} from "../../src/pipeline/artifacts/prompts";
import {
  ARTIFACT_REGISTRY,
  type ArtifactEligibilityContext,
  type ArticleMetadata,
} from "../../src/pipeline/artifacts/registry";

// Technology products of N§3 (#131): every field traces to approved source text.

const BODY_A =
  "Acme today released Orion-2, a model it says scores 92 percent on the CodeBench suite. In March 2026 Acme shipped Orion-1.";
const BODY_B =
  "An independent evaluation by the Open Eval Lab found that Orion-2 scored 81 percent on CodeBench, below the vendor figure.";
const MATERIAL: ArtifactEventMaterial = {
  eventId: 131,
  eventTitle: "Orion-2 launch",
  industryName: "Technology",
  industrySlug: "technology",
  articles: [
    {
      id: 1,
      title: "Acme releases Orion-2",
      sourceName: "Acme",
      sourceDomain: "acme.test",
      publishedAt: Date.UTC(2026, 9, 20),
      summary: "S1",
      bodyText: BODY_A,
    },
    {
      id: 2,
      title: "Lab tests Orion-2",
      sourceName: "Open Eval Lab",
      sourceDomain: "openeval.test",
      publishedAt: null,
      summary: "S2",
      bodyText: BODY_B,
    },
  ],
  verifiedClaims: [],
};

const CLAIM_QUOTE = {
  articleId: 1,
  quote: "scores 92 percent on the CodeBench suite",
};
const EVIDENCE_QUOTE = {
  articleId: 2,
  quote: "Orion-2 scored 81 percent on CodeBench",
};

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim: "Orion-2 scores 92 percent on CodeBench.",
    claimQuote: CLAIM_QUOTE,
    verdict: "independent_dispute",
    independentEvidence: [EVIDENCE_QUOTE],
    ...overrides,
  };
}

function check(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Orion-2",
    claimant: "Acme",
    claims: [claim()],
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    date: "March 2026",
    dateSource: "stated_in_text",
    kind: "release",
    description: "Acme shipped Orion-1.",
    source: { articleId: 1, quote: "In March 2026 Acme shipped Orion-1" },
    ...overrides,
  };
}

const EVAL_ENTRY = entry({
  date: "2026-10-20",
  dateSource: "report_published",
  kind: "evaluation",
  description: "The Open Eval Lab measured Orion-2 at 81 percent.",
  source: EVIDENCE_QUOTE,
});

function parseCheck(value: unknown) {
  return parseLaunchRealityCheckOutput(JSON.stringify(value), MATERIAL);
}

function parseTimeline(value: unknown) {
  return parseEvolutionTimelineOutput(JSON.stringify(value), MATERIAL);
}

describe("launchRealityCheckSchema (#131)", () => {
  it("accepts a valid check and rejects extra keys, 6 claims, and a 19-character quote", () => {
    expect(NOT_STATED_IN_SOURCES).toBe("Not stated in sources");
    expect(launchRealityCheckSchema.safeParse(check()).success).toBe(true);
    expect(
      launchRealityCheckSchema.safeParse({ ...check(), summary: "x" }).success,
    ).toBe(false);
    expect(
      launchRealityCheckSchema.safeParse(
        check({ claims: Array.from({ length: 6 }, () => claim()) }),
      ).success,
    ).toBe(false);
    expect(
      launchRealityCheckSchema.safeParse(
        check({
          claims: [
            claim({ claimQuote: { articleId: 1, quote: "x".repeat(19) } }),
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe("technologyEvolutionTimelineSchema (#131)", () => {
  it("accepts 2 entries and rejects 1 entry, 9 entries, and an unknown kind", () => {
    const schema = technologyEvolutionTimelineSchema;
    expect(schema.safeParse({ entries: [entry(), EVAL_ENTRY] }).success).toBe(
      true,
    );
    expect(schema.safeParse({ entries: [entry()] }).success).toBe(false);
    expect(
      schema.safeParse({ entries: Array.from({ length: 9 }, () => entry()) })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ entries: [entry({ kind: "rumor" }), EVAL_ENTRY] })
        .success,
    ).toBe(false);
  });
});

describe("parseLaunchRealityCheckOutput (#131)", () => {
  it("keeps grounded quotes and the verdict", () => {
    expect(parseCheck(check())).toEqual(check());
  });

  it("drops a claim whose quote is not in the article, and returns null when none is left", () => {
    const ungrounded = claim({
      claimQuote: { articleId: 1, quote: "scores 99 percent on Code" },
    });
    expect(parseCheck(check({ claims: [ungrounded] }))).toBeNull();

    const out = parseCheck(check({ claims: [ungrounded, claim()] }));
    expect(out?.claims).toEqual([claim()]);
  });

  it("drops a quote cited from an article outside the material", () => {
    const out = parseCheck(
      check({
        claims: [
          claim({
            independentEvidence: [{ ...EVIDENCE_QUOTE, articleId: 99 }],
          }),
        ],
      }),
    );
    expect(out?.claims).toHaveLength(1);
    expect(out?.claims[0].verdict).toBe("no_independent_evidence");
    expect(out?.claims[0].independentEvidence).toEqual([]);
  });

  it("clears evidence when the verdict is no_independent_evidence", () => {
    const out = parseCheck(
      check({ claims: [claim({ verdict: "no_independent_evidence" })] }),
    );
    expect(out?.claims[0].verdict).toBe("no_independent_evidence");
    expect(out?.claims[0].independentEvidence).toEqual([]);
  });

  it("drops evidence that repeats the claim quote", () => {
    const out = parseCheck(
      check({
        claims: [
          claim({
            verdict: "independent_support",
            independentEvidence: [
              {
                articleId: 1,
                quote: "  SCORES 92 percent on the\n  CodeBench suite ",
              },
            ],
          }),
        ],
      }),
    );
    expect(out?.claims[0].verdict).toBe("no_independent_evidence");
    expect(out?.claims[0].independentEvidence).toEqual([]);
  });

  it('replaces an ungrounded subject or claimant with "Not stated in sources"', () => {
    const out = parseCheck(check({ claimant: "Globex" }));
    expect(out?.claimant).toBe(NOT_STATED_IN_SOURCES);
    expect(out?.subject).toBe("Orion-2");

    const subject = parseCheck(check({ subject: "Orion-9" }));
    expect(subject?.subject).toBe(NOT_STATED_IN_SOURCES);
    expect(subject?.claimant).toBe("Acme");
  });

  it("treats whitespace padding as no source text", () => {
    // Padding passes the schema's length limits but matches every article.
    const padded = claim({
      claimQuote: { articleId: 1, quote: "a" + " ".repeat(19) },
    });
    expect(parseCheck(check({ claims: [padded] }))).toBeNull();
    const out = parseCheck(check({ subject: " ", claimant: "   " }));
    expect(out?.subject).toBe(NOT_STATED_IN_SOURCES);
    expect(out?.claimant).toBe(NOT_STATED_IN_SOURCES);
    const timeline = parseTimeline({
      entries: [entry({ date: "  " }), EVAL_ENTRY],
    });
    expect(timeline?.entries[0].date).toBe(NOT_STATED_IN_SOURCES);
  });

  it("returns null without material, on invalid JSON, and on a schema violation", () => {
    expect(parseLaunchRealityCheckOutput(JSON.stringify(check()))).toBeNull();
    expect(parseLaunchRealityCheckOutput("not json", MATERIAL)).toBeNull();
    expect(parseCheck({ ...check(), overallAssessment: "Good" })).toBeNull();
  });
});

describe("parseEvolutionTimelineOutput (#131)", () => {
  it("rewrites report_published dates from publishedAt", () => {
    const out = parseTimeline({
      entries: [
        entry({
          date: "yesterday",
          dateSource: "report_published",
          source: {
            articleId: 1,
            quote: "Acme today released Orion-2, a model",
          },
        }),
        { ...EVAL_ENTRY, date: "yesterday" },
      ],
    });
    expect(out?.entries.map((e) => e.date)).toEqual([
      "2026-10-20",
      NOT_STATED_IN_SOURCES,
    ]);
  });

  it("keeps a stated date only when the article text contains it", () => {
    const out = parseTimeline({
      entries: [
        entry(),
        entry({ date: "April 2025" }),
        // "March 2026" is in article 1, not in the cited article 2.
        { ...EVAL_ENTRY, date: "March 2026", dateSource: "stated_in_text" },
      ],
    });
    expect(out?.entries.map((e) => e.date)).toEqual([
      "March 2026",
      NOT_STATED_IN_SOURCES,
      NOT_STATED_IN_SOURCES,
    ]);
  });

  it("returns null without material and on invalid JSON", () => {
    const valid = JSON.stringify({ entries: [entry(), EVAL_ENTRY] });
    expect(parseEvolutionTimelineOutput(valid, MATERIAL)).not.toBeNull();
    expect(parseEvolutionTimelineOutput(valid)).toBeNull();
    expect(parseEvolutionTimelineOutput("not json", MATERIAL)).toBeNull();
  });

  it("returns null when fewer than 2 grounded entries are left", () => {
    expect(
      parseTimeline({
        entries: [
          entry(),
          {
            ...EVAL_ENTRY,
            source: {
              articleId: 2,
              quote: "Orion-2 scored 99 percent on CodeBench",
            },
          },
        ],
      }),
    ).toBeNull();
  });
});

function ctx(
  overrides: Partial<ArtifactEligibilityContext> & {
    contentTypes?: (string | null)[];
  } = {},
): ArtifactEligibilityContext {
  const { contentTypes = ["product_launch"], ...rest } = overrides;
  const articles: ArticleMetadata[] = contentTypes.map((contentType, i) => ({
    id: i + 1,
    sourceDomain: "acme.test",
    contentType,
    evidenceTags: [],
  }));
  return {
    eventScore: 70,
    selectThreshold: 60,
    deepThreshold: 60,
    articles,
    industrySlug: "technology",
    industryName: "Technology",
    ...rest,
  };
}

describe("Technology product eligibility (#131)", () => {
  it("launch_reality_check needs the technology section and a model_release or product_launch article", () => {
    const eligible = ARTIFACT_REGISTRY.launch_reality_check.isEligible;
    expect(eligible(ctx({ contentTypes: ["product_launch"] }))).toBe(true);
    expect(eligible(ctx({ contentTypes: ["model_release"] }))).toBe(true);
    expect(eligible(ctx({ contentTypes: ["research_paper"] }))).toBe(false);
    expect(
      eligible(
        ctx({ industrySlug: "education", contentTypes: ["product_launch"] }),
      ),
    ).toBe(false);
    expect(eligible(ctx({ eventScore: 0 }))).toBe(true);
  });

  it("technology_evolution_timeline needs the technology section and 2 approved articles", () => {
    const eligible = ARTIFACT_REGISTRY.technology_evolution_timeline.isEligible;
    const two = ["research_paper", "opinion_analysis"];
    expect(eligible(ctx({ contentTypes: two }))).toBe(true);
    expect(eligible(ctx({ contentTypes: ["research_paper"] }))).toBe(false);
    expect(eligible(ctx({ industrySlug: "industry", contentTypes: two }))).toBe(
      false,
    );
    expect(eligible(ctx({ eventScore: 0, contentTypes: two }))).toBe(true);
  });
});

describe("Technology product requests (#131)", () => {
  it("set thinking, the output limit, and Daily", () => {
    const requests = [
      buildLaunchRealityCheckRequest(MATERIAL),
      buildEvolutionTimelineRequest(MATERIAL),
    ];
    for (const req of requests) {
      expect(req.thinkingConfig).toEqual({ thinkingLevel: "low" });
      expect(req.maxOutputTokens).toBe(3000);
      expect(req.system).toContain("Daily");
      expect(req.system).not.toContain("Personal News");
    }
    expect(requests[1].prompt).toContain("- Article ID 1: 2026-10-20");
    expect(requests[1].prompt).toContain("- Article ID 2: not stated");
  });
});
