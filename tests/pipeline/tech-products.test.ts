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
  type ArtifactArticleMaterial,
  type ArtifactEventMaterial,
} from "../../src/pipeline/artifacts/prompts";
import { groundedSentences } from "../../src/lib/artifacts/grounding";
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
      canonicalUrl: "https://acme.test/orion-2",
      publishedAt: Date.UTC(2026, 9, 20),
      summary: "S1",
      bodyText: BODY_A,
      sourceBodyText: BODY_A,
    },
    {
      id: 2,
      title: "Lab tests Orion-2",
      sourceName: "Open Eval Lab",
      sourceDomain: "openeval.test",
      canonicalUrl: "https://openeval.test/orion-2",
      publishedAt: null,
      summary: "S2",
      bodyText: BODY_B,
      sourceBodyText: BODY_B,
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

// #144 B: a quote that passes the gate is stored as every body sentence it
// touches, so the card shows the source's own sentence, not a substring.
const CLAIM_SENTENCE = {
  articleId: 1,
  quote:
    "Acme today released Orion-2, a model it says scores 92 percent on the CodeBench suite.",
};
const EVIDENCE_SENTENCE = { articleId: 2, quote: BODY_B };

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim: "Orion-2 scores 92 percent on CodeBench.",
    claimQuote: CLAIM_QUOTE,
    verdict: "independent_dispute",
    independentEvidence: [EVIDENCE_QUOTE],
    ...overrides,
  };
}

/** claim() as the parser stores it: quotes expanded to whole sentences. */
function storedClaim(overrides: Record<string, unknown> = {}) {
  return claim({
    claimQuote: CLAIM_SENTENCE,
    independentEvidence: [EVIDENCE_SENTENCE],
    ...overrides,
  });
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

/** MATERIAL with each article edited, plus extra articles. */
function withArticles(
  extra: ArtifactArticleMaterial[] = [],
  edit: (
    a: ArtifactArticleMaterial,
  ) => Partial<ArtifactArticleMaterial> = () => ({}),
): ArtifactEventMaterial {
  return {
    ...MATERIAL,
    articles: [
      ...MATERIAL.articles.map((a) => ({ ...a, ...edit(a) })),
      ...extra,
    ],
  };
}

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
    expect(parseCheck(check())).toEqual(check({ claims: [storedClaim()] }));
  });

  it("drops a claim whose quote is not in the article, and returns null when none is left", () => {
    const ungrounded = claim({
      claimQuote: { articleId: 1, quote: "scores 99 percent on Code" },
    });
    expect(parseCheck(check({ claims: [ungrounded] }))).toBeNull();

    const out = parseCheck(check({ claims: [ungrounded, claim()] }));
    expect(out?.claims).toEqual([storedClaim()]);
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
    // A different source repeats the vendor sentence word for word.
    const wire = withArticles([
      {
        id: 3,
        title: "Wire copy",
        sourceName: "Wire",
        sourceDomain: "wire.test",
        canonicalUrl: "https://wire.test/orion-2",
        publishedAt: null,
        summary: "S3",
        bodyText: "Acme said Orion-2 scores 92 percent on the CodeBench suite.",
        sourceBodyText:
          "Acme said Orion-2 scores 92 percent on the CodeBench suite.",
      },
    ]);
    const out = parseLaunchRealityCheckOutput(
      JSON.stringify(
        check({
          claims: [
            claim({
              verdict: "independent_support",
              independentEvidence: [
                {
                  articleId: 3,
                  quote: "  scores 92 percent on the\n  CodeBench suite ",
                },
              ],
            }),
          ],
        }),
      ),
      wire,
    );
    expect(out?.claims[0].verdict).toBe("no_independent_evidence");
    expect(out?.claims[0].independentEvidence).toEqual([]);
  });

  it("drops evidence whose stored sentence is the claim's, even from a different substring", () => {
    // The wire article repeats the vendor sentence. The model quotes two
    // different parts of it, so the quote texts differ but the stored
    // sentences are the same.
    const sentence =
      "Acme today released Orion-2, a model it says scores 92 percent on the CodeBench suite.";
    const wire = withArticles([
      {
        id: 3,
        title: "Wire copy",
        sourceName: "Wire",
        sourceDomain: "wire.test",
        canonicalUrl: "https://wire.test/orion-2",
        publishedAt: null,
        summary: "S3",
        bodyText: sentence,
        sourceBodyText: sentence,
      },
    ]);
    const out = parseLaunchRealityCheckOutput(
      JSON.stringify(
        check({
          claims: [
            claim({
              verdict: "independent_support",
              independentEvidence: [
                { articleId: 3, quote: "Acme today released Orion-2" },
              ],
            }),
          ],
        }),
      ),
      wire,
    );
    expect(out?.claims[0].claimQuote.quote).toBe(sentence);
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
  });

  it("returns null without material, on invalid JSON, and on a schema violation", () => {
    expect(parseLaunchRealityCheckOutput(JSON.stringify(check()))).toBeNull();
    expect(parseLaunchRealityCheckOutput("not json", MATERIAL)).toBeNull();
    expect(parseCheck({ ...check(), overallAssessment: "Good" })).toBeNull();
  });
});

describe("parseEvolutionTimelineOutput (#131)", () => {
  it("stores whole-sentence quotes and keeps the model's dates unchanged and in order", () => {
    // The model's date and dateSource stay in the JSON; the card never shows
    // them (#144 B): it shows the cited article's publish date instead.
    const out = parseTimeline({
      entries: [
        { ...EVAL_ENTRY, date: "yesterday" },
        entry({ date: "May 2026", dateSource: "report_published" }),
      ],
    });
    expect(out?.entries.map((e) => [e.date, e.dateSource])).toEqual([
      ["yesterday", "report_published"],
      ["May 2026", "report_published"],
    ]);
    expect(out?.entries.map((e) => e.source)).toEqual([
      EVIDENCE_SENTENCE,
      { articleId: 1, quote: "In March 2026 Acme shipped Orion-1." },
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

describe("Technology product grounding (#131 review)", () => {
  const UNIT_BODY = BODY_A + " The Orion-2 chip draws 50 mW of power at idle.";
  const units = withArticles([], (a) =>
    a.id === 1 ? { bodyText: UNIT_BODY, sourceBodyText: UNIT_BODY } : {},
  );

  it("matches quotes case-sensitively: a changed unit is rejected", () => {
    const quote = (q: string) =>
      check({
        claims: [claim({ claimQuote: { articleId: 1, quote: q } })],
      });
    const exact = "The Orion-2 chip draws 50 mW of power at idle";
    expect(
      parseLaunchRealityCheckOutput(JSON.stringify(quote(exact)), units),
    ).not.toBeNull();
    expect(
      parseLaunchRealityCheckOutput(
        JSON.stringify(quote(exact.replace("50 mW", "50 MW"))),
        units,
      ),
    ).toBeNull();

    const timeline = (q: string) =>
      parseEvolutionTimelineOutput(
        JSON.stringify({
          entries: [entry({ source: { articleId: 1, quote: q } }), EVAL_ENTRY],
        }),
        units,
      );
    expect(timeline(exact)).not.toBeNull();
    expect(timeline(exact.replace("50 mW", "50 MW"))).toBeNull();
  });

  it("matches names case-sensitively", () => {
    const out = parseCheck(check({ subject: "orion-2", claimant: "ACME" }));
    expect(out?.subject).toBe(NOT_STATED_IN_SOURCES);
    expect(out?.claimant).toBe(NOT_STATED_IN_SOURCES);
  });

  it("drops evidence from the claim's own article", () => {
    const out = parseCheck(
      check({
        claims: [
          claim({
            verdict: "independent_support",
            // One more full stop than the claim quote; still article 1.
            independentEvidence: [
              {
                articleId: 1,
                quote: "scores 92 percent on the CodeBench suite.",
              },
            ],
          }),
        ],
      }),
    );
    expect(out?.claims[0].verdict).toBe("no_independent_evidence");
    expect(out?.claims[0].independentEvidence).toEqual([]);
  });

  it("drops evidence from another article of the claim's domain", () => {
    const sameDomain = withArticles([], (a) => ({
      canonicalUrl: `https://acme.test/story-${a.id}`,
    }));
    const out = parseLaunchRealityCheckOutput(
      JSON.stringify(check()),
      sameDomain,
    );
    expect(out?.claims).toHaveLength(1);
    expect(out?.claims[0].verdict).toBe("no_independent_evidence");
    expect(out?.claims[0].independentEvidence).toEqual([]);
  });

  it("produces nothing when no article has a source body, only a summary", () => {
    // build.ts sends the summary as bodyText when R2 has no body.
    const summaryOnly = withArticles([], () => ({ sourceBodyText: null }));
    expect(
      parseLaunchRealityCheckOutput(JSON.stringify(check()), summaryOnly),
    ).toBeNull();
    expect(
      parseEvolutionTimelineOutput(
        JSON.stringify({ entries: [entry(), EVAL_ENTRY] }),
        summaryOnly,
      ),
    ).toBeNull();
  });

  it("checks names against the source body, not the summary", () => {
    // Article 2's bodyText carries extra text that its source body lacks.
    const extra = withArticles([], (a) =>
      a.id === 2 ? { bodyText: `Globex, April 2025. ${BODY_B}` } : {},
    );
    const out = parseLaunchRealityCheckOutput(
      JSON.stringify(check({ claimant: "Globex" })),
      extra,
    );
    expect(out?.claimant).toBe(NOT_STATED_IN_SOURCES);
  });

  it("drops a quote bound to article A that exists only in article B", () => {
    const misbound = { articleId: 1, quote: EVIDENCE_QUOTE.quote };
    expect(
      parseCheck(check({ claims: [claim({ claimQuote: misbound })] })),
    ).toBeNull();
    expect(
      parseTimeline({ entries: [entry({ source: misbound }), EVAL_ENTRY] }),
    ).toBeNull();
  });
});

describe("Technology product grounding (#144 review)", () => {
  /** MATERIAL with article 1's source body replaced. */
  function withBody(body: string): ArtifactEventMaterial {
    return withArticles([], (a) =>
      a.id === 1 ? { bodyText: body, sourceBodyText: body } : {},
    );
  }
  function checkQuote(q: string, material: ArtifactEventMaterial) {
    return parseLaunchRealityCheckOutput(
      JSON.stringify(
        check({ claims: [claim({ claimQuote: { articleId: 1, quote: q } })] }),
      ),
      material,
    );
  }
  function timelineQuote(q: string, material: ArtifactEventMaterial) {
    return parseEvolutionTimelineOutput(
      JSON.stringify({
        entries: [entry({ source: { articleId: 1, quote: q } }), EVAL_ENTRY],
      }),
      material,
    );
  }

  it("rejects a quote that starts inside a number: 50 mW in 150 mW", () => {
    const body = `${BODY_A} The Orion-2 chip draws 150 mW of power at idle.`;
    const q = "50 mW of power at idle";
    expect(checkQuote(q, withBody(body))).toBeNull();
    expect(timelineQuote(q, withBody(body))).toBeNull();
  });

  it("rejects a quote that ends inside a word: 50 MW in 50 MWh", () => {
    const body = `${BODY_A} The new plant stores 50 MWh of energy.`;
    const q = "The new plant stores 50 MW";
    expect(checkQuote(q, withBody(body))).toBeNull();
    expect(timelineQuote(q, withBody(body))).toBeNull();
  });

  it("accepts a quote at the start and at the end of the body", () => {
    const start = "Acme today released Orion-2, a model";
    const end = "In March 2026 Acme shipped Orion-1.";
    expect(BODY_A.startsWith(start)).toBe(true);
    expect(BODY_A.endsWith(end)).toBe(true);
    expect(checkQuote(start, MATERIAL)).not.toBeNull();
    expect(checkQuote(end, MATERIAL)).not.toBeNull();
    expect(timelineQuote(start, MATERIAL)).not.toBeNull();
    expect(timelineQuote(end, MATERIAL)).not.toBeNull();
  });

  // #144 round 3: "." or "," between two digits is part of one number.
  it("rejects a quote that starts inside a decimal: 50 mW in 150.50 mW", () => {
    const body = `${BODY_A} The chip draws 150.50 mW of power at idle.`;
    const q = "50 mW of power at idle";
    expect(checkQuote(q, withBody(body))).toBeNull();
    expect(timelineQuote(q, withBody(body))).toBeNull();
  });

  it("rejects a quote that starts inside a grouped number: 200 in 1,200", () => {
    const body = `${BODY_A} Acme sold 1,200 units of the chip in March.`;
    const q = "200 units of the chip in March";
    expect(checkQuote(q, withBody(body))).toBeNull();
    expect(timelineQuote(q, withBody(body))).toBeNull();
  });

  it("accepts a digit-led quote after a dot that does not follow a digit", () => {
    const body = `${BODY_A} That is the end.50 mW of power at idle is the draw.`;
    const q = "50 mW of power at idle";
    expect(checkQuote(q, withBody(body))).not.toBeNull();
    expect(timelineQuote(q, withBody(body))).not.toBeNull();
  });

  it("rejects a quote that ends inside a decimal: costs 1 in costs 1.5", () => {
    const body = `${BODY_A} The new chip costs 1.5 million dollars.`;
    const q = "The new chip costs 1";
    expect(checkQuote(q, withBody(body))).toBeNull();
    expect(timelineQuote(q, withBody(body))).toBeNull();
  });

  it("rejects a quote that ends inside a grouped number: sold 1 in sold 1,200", () => {
    const body = `${BODY_A} This quarter the vendor sold 1,200 units.`;
    const q = "This quarter the vendor sold 1";
    expect(checkQuote(q, withBody(body))).toBeNull();
    expect(timelineQuote(q, withBody(body))).toBeNull();
  });

  it("accepts a digit-ended quote before a sentence-ending dot", () => {
    const body = `${BODY_A} The benchmark score rose to 50. Then it fell.`;
    const q = "The benchmark score rose to 50";
    expect(checkQuote(q, withBody(body))).not.toBeNull();
    expect(timelineQuote(q, withBody(body))).not.toBeNull();
  });

  // #144 B: a punctuation edge gets no exemption from the word boundary;
  // the quote without that mark passes and expands to the whole sentence.
  it("rejects a quote that ends with punctuation directly before a word", () => {
    const body = `${BODY_A} The chip draws 50 mW.Next comes Orion-3.`;
    expect(checkQuote("The chip draws 50 mW.", withBody(body))).toBeNull();
    expect(timelineQuote("The chip draws 50 mW.", withBody(body))).toBeNull();
    const out = checkQuote("The chip draws 50 mW", withBody(body));
    expect(out?.claims[0].claimQuote.quote).toBe(
      "The chip draws 50 mW.Next comes Orion-3.",
    );
  });

  it("rejects a quote that starts with an opening quote mark directly after a word", () => {
    const body = `${BODY_A} Acme said\u201cOrion-2 is the fastest model we have built\u201d today.`;
    const q = "\u201cOrion-2 is the fastest model we have built";
    expect(checkQuote(q, withBody(body))).toBeNull();
    expect(timelineQuote(q, withBody(body))).toBeNull();
    const out = timelineQuote(q.slice(1), withBody(body));
    expect(out?.entries[0].source.quote).toBe(
      "Acme said\u201cOrion-2 is the fastest model we have built\u201d today.",
    );
  });

  it("accepts a valid later occurrence after a non-boundary one", () => {
    const body = `${BODY_A} The 150 mW part idles too. The 50 mW part idles too.`;
    const q = "50 mW part idles too.";
    expect(checkQuote(q, withBody(body))).not.toBeNull();
    expect(timelineQuote(q, withBody(body))).not.toBeNull();
  });

  it("matches names at word boundaries", () => {
    const out = parseCheck(check({ subject: "Orion-2", claimant: "Acm" }));
    expect(out?.subject).toBe("Orion-2");
    expect(out?.claimant).toBe(NOT_STATED_IN_SOURCES);
  });

  /** A canonical URL on `host`; "" stays "", which the URL parser rejects. */
  function urlOn(host: string): string {
    return host === "" ? "" : `https://${host}/story`;
  }

  /** The default check with article 1 on `claim` and article 2 on `evidence`. */
  function domains(claimDomain: string, evidenceDomain: string) {
    return parseLaunchRealityCheckOutput(
      JSON.stringify(check()),
      withArticles([], (a) => ({
        canonicalUrl: urlOn(a.id === 1 ? claimDomain : evidenceDomain),
      })),
    );
  }

  it.each([
    ["vendor.com", "blog.vendor.com"],
    ["vendor.com", "vendor.com."],
    ["vendor.com", "www.vendor.com"],
    ["www.vendor.com", "VENDOR.COM"],
    ["", "openeval.test"],
    ["acme.test", ""],
    ["", ""],
    // Two labels only: here "www." is what makes the keys equal.
    ["vendor", "www.vendor"],
    // URL hostname normalisation (#144 round 3): port, IDN, IP aliases.
    ["vendor.com:443", "vendor.com"],
    ["vendor.com..", "vendor.com"],
    ["b\u00fccher.de", "xn--bcher-kva.de"],
    ["0x7f.1", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["[::1]", "[0:0:0:0:0:0:0:1]"],
    ["[2001:db8::1]", "[2001:0db8:0000:0000:0000:0000:0000:0001]"],
    // Not a host name: the URL parser throws, so the key is empty.
    ["a b.com", "openeval.test"],
    [".", "openeval.test"],
  ])(
    "drops evidence when the domain keys of %j and %j are equal or empty",
    (claimDomain, evidenceDomain) => {
      const out = domains(claimDomain, evidenceDomain);
      expect(out?.claims).toHaveLength(1);
      expect(out?.claims[0].verdict).toBe("no_independent_evidence");
      expect(out?.claims[0].independentEvidence).toEqual([]);
    },
  );

  it.each([
    ["vendor.com", "openeval.test"],
    ["vendor.com", "othervendor.com"],
    ["news.vendor.com", "vendor.org"],
    // An IP literal is its own key, not its last two labels.
    ["10.0.0.1", "192.168.0.1"],
    ["[2001:db8::1]", "[2001:db8::2]"],
  ])("keeps evidence from %j against %j", (claimDomain, evidenceDomain) => {
    const out = domains(claimDomain, evidenceDomain);
    expect(out?.claims[0].verdict).toBe("independent_dispute");
    expect(out?.claims[0].independentEvidence).toEqual([EVIDENCE_SENTENCE]);
  });

  it("drops a quote bound to article B that exists only in article A", () => {
    const misbound = { articleId: 2, quote: CLAIM_QUOTE.quote };
    expect(
      parseCheck(check({ claims: [claim({ claimQuote: misbound })] })),
    ).toBeNull();
    expect(
      parseTimeline({
        entries: [
          entry({
            source: {
              articleId: 2,
              quote: "In March 2026 Acme shipped Orion-1",
            },
          }),
          EVAL_ENTRY,
        ],
      }),
    ).toBeNull();
  });

  it("drops evidence whose quote exists only in another article than its articleId", () => {
    const BODY_C =
      "The Third Lab measured Orion-2 at 80 percent on CodeBench in its own run.";
    const third = withArticles([
      {
        id: 3,
        title: "Third lab",
        sourceName: "Third Lab",
        sourceDomain: "thirdlab.test",
        canonicalUrl: "https://thirdlab.test/orion-2",
        publishedAt: null,
        summary: "S3",
        bodyText: BODY_C,
        sourceBodyText: BODY_C,
      },
    ]);
    const run = (evidence: { articleId: number; quote: string }) =>
      parseLaunchRealityCheckOutput(
        JSON.stringify(
          check({ claims: [claim({ independentEvidence: [evidence] })] }),
        ),
        third,
      );
    // Control: each quote is kept when bound to its own article.
    const own = run({
      articleId: 3,
      quote: "measured Orion-2 at 80 percent on CodeBench",
    });
    expect(own?.claims[0].independentEvidence).toHaveLength(1);
    for (const evidence of [
      { articleId: 2, quote: "measured Orion-2 at 80 percent on CodeBench" },
      { articleId: 3, quote: EVIDENCE_QUOTE.quote },
    ]) {
      const out = run(evidence);
      expect(out?.claims[0].verdict).toBe("no_independent_evidence");
      expect(out?.claims[0].independentEvidence).toEqual([]);
    }
  });
});

describe("Technology product quotes are whole sentences (#144 B)", () => {
  /** MATERIAL with article 1's source body replaced. */
  function withBody(body: string): ArtifactEventMaterial {
    return withArticles([], (a) =>
      a.id === 1 ? { bodyText: body, sourceBodyText: body } : {},
    );
  }
  /** The stored claim quote, or null when the claim is dropped. */
  function storedQuote(q: string, body: string): string | null {
    const out = parseLaunchRealityCheckOutput(
      JSON.stringify(
        check({ claims: [claim({ claimQuote: { articleId: 1, quote: q } })] }),
      ),
      withBody(body),
    );
    return out?.claims[0].claimQuote.quote ?? null;
  }
  /** The stored timeline quote of the first entry, or null. */
  function storedEntryQuote(q: string, body: string): string | null {
    const out = parseEvolutionTimelineOutput(
      JSON.stringify({
        entries: [entry({ source: { articleId: 1, quote: q } }), EVAL_ENTRY],
      }),
      withBody(body),
    );
    return out?.entries[0].source.quote ?? null;
  }

  // Codex repros of #144 rounds 2-4. Each quote passes the gate on a
  // substring; the stored text is the whole sentence, so nothing is cut.
  it.each([
    [
      "a minus sign",
      "The sensor works at -50 degrees Celsius in the field test.",
      "50 degrees Celsius in the field test",
    ],
    [
      "a leading decimal point",
      "The chip draws .50 mW of power at idle.",
      "50 mW of power at idle",
    ],
    [
      "a range",
      "The chip draws 10-20 mW of power at idle.",
      "20 mW of power at idle",
    ],
    [
      "a percent sign",
      "Accuracy rose from 81% to 92% on CodeBench.",
      "Accuracy rose from 81% to 92",
    ],
    [
      "a footnote marker",
      "The Orion-2 chip draws 50 mW.\u00b9 Next comes Orion-3.",
      "The Orion-2 chip draws 50 mW",
    ],
  ])("stores the whole sentence around %s", (_name, sentence, q) => {
    const body = `${BODY_A} ${sentence}`;
    expect(storedQuote(q, body)).toBe(sentence);
    expect(storedEntryQuote(q, body)).toBe(sentence);
  });

  it.each([
    [
      "50 mW in 150 mW",
      "The chip draws 150 mW of power at idle.",
      "50 mW of power at idle",
    ],
    [
      "50 mW in 150.50 mW",
      "The chip draws 150.50 mW of power at idle.",
      "50 mW of power at idle",
    ],
    [
      "50 MW in 50 MWh",
      "The new plant stores 50 MWh of energy.",
      "The new plant stores 50 MW",
    ],
  ])("still drops a quote that fails the gate: %s", (_name, sentence, q) => {
    expect(storedQuote(q, `${BODY_A} ${sentence}`)).toBeNull();
    expect(storedEntryQuote(q, `${BODY_A} ${sentence}`)).toBeNull();
  });

  it("stores the rival's whole sentence, so the card can name who scored", () => {
    const body = `${BODY_A} Rival Vega-1 scores 95 percent on the CodeBench suite.`;
    expect(storedQuote("scores 95 percent on the CodeBench suite", body)).toBe(
      "Rival Vega-1 scores 95 percent on the CodeBench suite.",
    );
  });

  it("expands to every sentence a quote touches, with original whitespace collapsed", () => {
    const body = `${BODY_A} The chip draws 50 mW  of power\tat idle. Then it\n sleeps for an hour. Last line.`;
    expect(storedQuote("of power at idle. Then it", body)).toBe(
      "The chip draws 50 mW of power at idle. Then it",
    );
    expect(storedQuote("power at idle. Then it sleeps", body)).toBe(
      "The chip draws 50 mW of power at idle. Then it sleeps for an hour.",
    );
  });

  it("keeps the 20-character minimum on the model's quote, not on the sentence", () => {
    const body = `${BODY_A} It draws 50 mW of power at idle.`;
    expect(storedQuote("draws 50 mW of power", body)).toBe(
      "It draws 50 mW of power at idle.",
    );
    expect(storedQuote("mW of power at idle", body)).toBeNull();
  });

  it("follows canonical_url, not the source's site domain, for independence", () => {
    const run = (site: (id: number) => string, url: (id: number) => string) =>
      parseLaunchRealityCheckOutput(
        JSON.stringify(check()),
        withArticles([], (a) => ({
          sourceDomain: site(a.id),
          canonicalUrl: url(a.id),
        })),
      )?.claims[0].independentEvidence;
    // Site domains differ, but both articles live on vendor.com: dropped.
    expect(
      run(
        (id) => (id === 1 ? "https://vendor.com" : "https://lab.org"),
        (id) =>
          id === 1 ? "https://www.vendor.com/a" : "https://news.vendor.com/b",
      ),
    ).toEqual([]);
    // Site domains are equal, but the articles live on different hosts: kept.
    expect(
      run(
        () => "vendor.com",
        (id) => (id === 1 ? "https://vendor.com/a" : "https://lab.org/b"),
      ),
    ).toEqual([EVIDENCE_SENTENCE]);
  });

  it.each([["mailto:press@vendor.com"], ["not a url"], ["https://./x"]])(
    "drops evidence when a canonical_url gives an empty key: %j",
    (url) => {
      for (const id of [1, 2]) {
        const out = parseLaunchRealityCheckOutput(
          JSON.stringify(check()),
          withArticles([], (a) => (a.id === id ? { canonicalUrl: url } : {})),
        );
        expect(out?.claims[0].verdict).toBe("no_independent_evidence");
        expect(out?.claims[0].independentEvidence).toEqual([]);
      }
    },
  );
});

describe("groundedSentences (#144 B)", () => {
  const LEAD = "First part ends here.";
  const QUOTE = "Smith said the model scores 92 percent";
  const TAIL = "on the suite.";

  it.each([
    "Mr",
    "Mrs",
    "Ms",
    "Dr",
    "Prof",
    "St",
    "Inc",
    "Corp",
    "Ltd",
    "Co",
    "vs",
    "etc",
    "e.g",
    "i.e",
    "U.S",
    "U.K",
    "No",
  ])("does not split after the abbreviation %s.", (abbr) => {
    const sentence = `Then ${abbr}. ${QUOTE} ${TAIL}`;
    expect(groundedSentences(`${LEAD} ${sentence}`, QUOTE)).toBe(sentence);
  });

  it("splits after a word that is not in the abbreviation list", () => {
    expect(
      groundedSentences(`${LEAD} Then Acme. ${QUOTE} ${TAIL}`, QUOTE),
    ).toBe(`${QUOTE} ${TAIL}`);
    expect(groundedSentences(`${LEAD} Then Jo. ${QUOTE} ${TAIL}`, QUOTE)).toBe(
      `${QUOTE} ${TAIL}`,
    );
  });

  it("does not split after a single capital letter", () => {
    const sentence = `Then J. ${QUOTE} ${TAIL}`;
    expect(groundedSentences(`${LEAD} ${sentence}`, QUOTE)).toBe(sentence);
    // A single lowercase letter is not an initial.
    expect(groundedSentences(`${LEAD} Then j. ${QUOTE} ${TAIL}`, QUOTE)).toBe(
      `${QUOTE} ${TAIL}`,
    );
  });

  it("does not split at a period between digits", () => {
    const sentence = "The chip costs 1.5 million dollars at launch.";
    expect(
      groundedSentences(`${LEAD} ${sentence}`, "million dollars at launch"),
    ).toBe(sentence);
  });

  it("splits after ! and ?, and after a closing quote or bracket", () => {
    for (const end of ["!", "?", '."', ".\u201d", ".)", ".]", ".'"]) {
      expect(
        groundedSentences(`Lead ends here${end} ${QUOTE} ${TAIL}`, QUOTE),
      ).toBe(`${QUOTE} ${TAIL}`);
    }
    // The closing mark belongs to the sentence it closes.
    expect(
      groundedSentences(`He said "${QUOTE} ${TAIL}" Then more.`, QUOTE),
    ).toBe(`He said "${QUOTE} ${TAIL}"`);
  });

  it("does not split at punctuation that is not followed by whitespace", () => {
    expect(groundedSentences(`Lead ends here.${QUOTE} ${TAIL}`, QUOTE)).toBe(
      `Lead ends here.${QUOTE} ${TAIL}`,
    );
  });

  it("always splits at a newline, with or without a full stop", () => {
    expect(groundedSentences(`A heading\n${QUOTE} ${TAIL}`, QUOTE)).toBe(
      `${QUOTE} ${TAIL}`,
    );
    expect(groundedSentences(`${QUOTE} with no stop\nNext line.`, QUOTE)).toBe(
      `${QUOTE} with no stop`,
    );
    expect(groundedSentences(`Lead\r\n${QUOTE}\r\nNext`, QUOTE)).toBe(QUOTE);
    // A quote across a newline matches after whitespace normalising and
    // takes both lines.
    expect(
      groundedSentences(
        `Smith said the model\nscores 92 percent ${TAIL}`,
        QUOTE,
      ),
    ).toBe(`${QUOTE} ${TAIL}`);
  });

  it("expands from the body start and to the body end", () => {
    expect(groundedSentences(`${QUOTE} ${TAIL} Next one.`, QUOTE)).toBe(
      `${QUOTE} ${TAIL}`,
    );
    expect(groundedSentences(`${LEAD} Then ${QUOTE}`, QUOTE)).toBe(
      `Then ${QUOTE}`,
    );
    expect(groundedSentences(`  \n${QUOTE}  `, QUOTE)).toBe(QUOTE);
  });

  it("returns null when the gate rejects the quote", () => {
    expect(groundedSentences(`${LEAD} ${QUOTE}s ${TAIL}`, QUOTE)).toBeNull();
    expect(groundedSentences(null, QUOTE)).toBeNull();
    expect(groundedSentences(`${LEAD} ${QUOTE}`, "   ")).toBeNull();
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
