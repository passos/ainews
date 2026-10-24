import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { generateEventEvidence } from "../../src/pipeline/evidence/build";
import { chunkMarkdownBody } from "../../src/pipeline/evidence/chunks";
import { enqueueDueEvidence } from "../../src/pipeline/evidence/schedule";
import {
  cleanMarkdownWithMap,
  evaluateClaimConsensus,
  isPrimarySourceDomain,
  verifyQuoteInBody,
} from "../../src/pipeline/evidence/verify";
import { handleGenerateBatch } from "../../src/pipeline/generate/consumer";
import type { GenerateMessage, PipelineEnv } from "../../src/pipeline/messages";
import type { ModelTransport } from "../../src/providers/transport";
import { getDb } from "../../src/server/db/client";
import { getEventEvidence } from "../../src/server/publication/evidence";

class FakeQueue {
  sent: GenerateMessage[] = [];
  async send(msg: GenerateMessage) {
    this.sent.push(msg);
  }
  async sendBatch(msgs: Iterable<{ body: GenerateMessage }>) {
    this.sent.push(...Array.from(msgs).map((m) => m.body));
  }
}

class FakeVectors {
  records: Array<{
    id: string;
    values: number[];
    metadata: Record<string, unknown>;
  }> = [];
  async upsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata: Record<string, unknown>;
    }>,
  ) {
    this.records.push(...vectors);
  }
}

class FakeR2 {
  storage = new Map<string, string>();
  put(key: string, value: string) {
    this.storage.set(key, value);
  }
  async get(key: string) {
    const val = this.storage.get(key);
    if (!val) return null;
    return {
      text: async () => val,
    };
  }
}

function makeFakeTransport(
  responder: (model: string, input: unknown) => unknown,
): ModelTransport {
  return {
    run: async (model: string, input: unknown) => {
      if (model === "@cf/baai/bge-m3") {
        const texts = Array.isArray((input as { text?: unknown }).text)
          ? (input as { text: string[] }).text
          : [""];
        return {
          shape: [texts.length, 3],
          data: texts.map(() => [0.1, 0.2, 0.3]),
        };
      }
      const resp = responder(model, input);
      const text = typeof resp === "string" ? resp : JSON.stringify(resp);
      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text }],
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

async function ensureBudget(day = "2026-10-24"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO budgets (day, channel, cap_micros, spent_micros, reserved_micros)
     VALUES (?1, 'gateway', 10000000, 0, 0)
     ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
  )
    .bind(day)
    .run();
  await env.DB.prepare(
    `INSERT INTO budgets (day, channel, cap_micros, spent_micros, reserved_micros)
     VALUES (?1, 'workers_ai', 10000000, 0, 0)
     ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
  )
    .bind(day)
    .run();
}

const testEnv: PipelineEnv = {
  ...env,
  MODEL_CALLS_ENABLED: "true",
};

describe("Evidence Chunks & Quote Verification", () => {
  it("chunks markdown body preserving paragraph offsets", () => {
    const text =
      "First paragraph with some text.\n\nSecond paragraph has more details.\n\nThird paragraph concludes.";
    const chunks = chunkMarkdownBody(text, 50, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(text.slice(chunk.start, chunk.end).trim()).toBe(chunk.text);
    }
  });

  it("verifyQuoteInBody verifies valid quote and returns exact offsets", () => {
    const body =
      "# Breakthrough\n\nResearchers achieved a 99.9% two-qubit gate fidelity under ambient conditions.";
    const quote =
      "Researchers achieved a 99.9% two-qubit gate fidelity under ambient conditions.";

    const res = verifyQuoteInBody(body, quote);
    expect(res.verified).toBe(true);
    expect(body.slice(res.startOffset, res.endOffset)).toBe(quote);
  });

  it("verifyQuoteInBody rejects quotes shorter than 15 characters", () => {
    const body = "This is a short statement.";
    const tooShort = "short";
    expect(verifyQuoteInBody(body, tooShort).verified).toBe(false);
  });

  it("verifyQuoteInBody rejects partial number/word matches", () => {
    const body = "The total round was $115 million in capital.";
    const badQuote = "15 million in capital"; // missing the '1' in '115'
    const res = verifyQuoteInBody(body, badQuote);
    expect(res.verified).toBe(false);
  });

  it("verifyQuoteInBody correctly locates target quote with markdown formatting when preceded by similar sentence prefix", () => {
    const body =
      "The company reported record losses in Q1. Later, the company reported record **revenue of $100 million** in Q4.";
    const quote = "company reported record revenue of $100 million";

    const res = verifyQuoteInBody(body, quote);
    expect(res.verified).toBe(true);
    // Crucial check: startOffset must point to the second sentence (index 53), NOT the first sentence (index 4)
    expect(res.startOffset).toBe(53);
    expect(body.slice(res.startOffset, res.endOffset)).toBe(
      "company reported record **revenue of $100 million",
    );
  });

  it("cleanMarkdownWithMap accurately preserves character mappings through formatting and link stripping", () => {
    const text =
      "See ![photo](https://example.com/p.png) and [read doc](https://example.com) for *crucial* **updates**.";
    const { cleanText, origIndices } = cleanMarkdownWithMap(text);
    expect(cleanText).toBe("See photo and read doc for crucial updates.");
    expect(origIndices.length).toBe(cleanText.length);
    // Verify mapped characters
    const docIdx = cleanText.indexOf("read doc");
    expect(text.slice(origIndices[docIdx], origIndices[docIdx + 7] + 1)).toBe(
      "read doc",
    );
  });

  it("verifyQuoteInBody handles large documents (>160KB) with links without call stack overflow", () => {
    const head =
      "[Opening Report](https://example.com/rep) The organization verified that **energy output exceeded 500 megawatts** during trial operations.\n\n";
    const tail =
      "Repeating context filler paragraph to build realistic large body text.\n\n".repeat(
        2500,
      );
    const body = head + tail;
    expect(body.length).toBeGreaterThan(160000);

    const quote =
      "organization verified that energy output exceeded 500 megawatts";
    const res = verifyQuoteInBody(body, quote);
    expect(res.verified).toBe(true);
    expect(body.slice(res.startOffset, res.endOffset)).toBe(
      "organization verified that **energy output exceeded 500 megawatts",
    );
  });

  it("verifyQuoteInBody rejects partial quote crossing markdown link boundaries", () => {
    const body =
      "This material is un[safe for human use](https://example.com) in food preparation.";
    const badQuote = "safe for human use";
    const res = verifyQuoteInBody(body, badQuote);
    expect(res.verified).toBe(false);
  });

  it("verifyQuoteInBody rejects partial quote with bold formatting across word prefix", () => {
    const body =
      "This material is un[**safe for human use**](https://example.com) in food preparation.";
    const badQuote = "safe for human use";
    expect(verifyQuoteInBody(body, badQuote).verified).toBe(false);

    const astralBody =
      "The initial funding round was 𝟙**15 million in capital**.";
    expect(
      verifyQuoteInBody(astralBody, "15 million in capital").verified,
    ).toBe(false);
  });

  it("verifyQuoteInBody handles massive unclosed brackets linearly without quadratic re-scan", () => {
    const body =
      "[".repeat(100000) + " The company reported record revenue in Q4.";
    const quote = "company reported record revenue in Q4";
    const t0 = Date.now();
    const res = verifyQuoteInBody(body, quote);
    const elapsed = Date.now() - t0;
    expect(res.verified).toBe(true);
    expect(elapsed).toBeLessThan(1000); // Must be linear, well under 1 second

    // Quadratic trap scenario: repeated '[' followed by shared '](' without ')'
    const quadraticTrap =
      "[".repeat(100000) +
      "](" +
      "x".repeat(100000) +
      " The company reported record revenue in Q4.";
    const t2 = Date.now();
    const res2 = verifyQuoteInBody(quadraticTrap, quote);
    const elapsed2 = Date.now() - t2;
    expect(res2.verified).toBe(true);
    expect(elapsed2).toBeLessThan(1000);
  });

  it("verifyQuoteInBody preserves literal symbols like C# and distinguishes from other words", () => {
    const body = "The C# language is memory-safe.";
    // Quote with "The C language" must NOT match "The C# language"
    expect(
      verifyQuoteInBody(body, "The C language is memory-safe.").verified,
    ).toBe(false);
    // Exact quote with "The C# language" must match
    const res = verifyQuoteInBody(body, "The C# language is memory-safe.");
    expect(res.verified).toBe(true);
    expect(body.slice(res.startOffset, res.endOffset)).toBe(
      "The C# language is memory-safe.",
    );
  });

  it("verifyQuoteInBody preserves isolated underscores and identifier underscores", () => {
    const body =
      "The measured value is _ units per second in function foo__bar().";
    const res = verifyQuoteInBody(
      body,
      "The measured value is _ units per second in function foo__bar().",
    );
    expect(res.verified).toBe(true);

    // Dropped underscore quote must be rejected
    expect(
      verifyQuoteInBody(
        body,
        "The measured value is units per second in function foo bar().",
      ).verified,
    ).toBe(false);

    // CommonMark unclosed or trailing underscores must be preserved
    const settingBody = "The required setting is API_KEY_ for production.";
    expect(
      verifyQuoteInBody(
        settingBody,
        "The required setting is API_KEY for production.",
      ).verified,
    ).toBe(false);
    expect(
      verifyQuoteInBody(
        settingBody,
        "The required setting is API_KEY_ for production.",
      ).verified,
    ).toBe(true);

    // Unpaired leading underscore
    const disabledBody = "The feature is _disabled by default.";
    expect(
      verifyQuoteInBody(disabledBody, "The feature is disabled by default.")
        .verified,
    ).toBe(false);

    // Underscores as word/identifier characters: reject sub-identifier matches
    const identBody = "function foo__bar() is called during execution.";
    expect(
      verifyQuoteInBody(identBody, "bar() is called during execution.")
        .verified,
    ).toBe(false);

    const keyBody = "The variable API_KEY_SECRET is set in environment.";
    expect(
      verifyQuoteInBody(keyBody, "KEY_SECRET is set in environment.").verified,
    ).toBe(false);
  });

  it("verifyQuoteInBody handles links with parentheses in URL and broken links gracefully", () => {
    const wikiBody =
      "Check [Apple](https://en.wikipedia.org/wiki/Apple_(disambiguation)) for details on the corporate entity.";
    const wikiQuote = "Apple for details on the corporate entity.";
    const wikiRes = verifyQuoteInBody(wikiBody, wikiQuote);
    expect(wikiRes.verified).toBe(true);
    expect(wikiBody.slice(wikiRes.startOffset, wikiRes.endOffset)).toBe(
      "Apple](https://en.wikipedia.org/wiki/Apple_(disambiguation)) for details on the corporate entity.",
    );

    const brokenBody =
      "[a](http://broken\n\n[Section 2](https://real.com) profit grew significantly.";
    const brokenQuote = "Section 2 profit grew significantly.";
    const brokenRes = verifyQuoteInBody(brokenBody, brokenQuote);
    expect(brokenRes.verified).toBe(true);
    expect(brokenBody.slice(brokenRes.startOffset, brokenRes.endOffset)).toBe(
      "Section 2](https://real.com) profit grew significantly.",
    );
  });

  it("verifyQuoteInBody handles HTML entities and preserves character offsets across paragraphs", () => {
    const body =
      "Revenue was &gt; $10 million in Q3.\n\nNext paragraph discusses margins.";
    const res = verifyQuoteInBody(body, "Next paragraph discusses margins.");
    expect(res.verified).toBe(true);
    expect(body.slice(res.startOffset, res.endOffset)).toBe(
      "Next paragraph discusses margins.",
    );

    const dashBody =
      "Growth was high &mdash; higher than expected. Second paragraph here.";
    const dashRes = verifyQuoteInBody(dashBody, "Second paragraph here.");
    expect(dashRes.verified).toBe(true);
    expect(dashBody.slice(dashRes.startOffset, dashRes.endOffset)).toBe(
      "Second paragraph here.",
    );
  });

  it("verifyQuoteInBody correctly slices quotes ending in decimal or named HTML entities without truncation", () => {
    const body =
      "Revenue increased by 1&#48;&#48; in the latest fiscal quarter.";
    const quote = "Revenue increased by 100";
    const res = verifyQuoteInBody(body, quote);
    expect(res.verified).toBe(true);
    expect(body.slice(res.startOffset, res.endOffset)).toBe(
      "Revenue increased by 1&#48;&#48;",
    );

    const namedBody =
      "Reported operating result &mdash; which was audited by experts.";
    const namedQuote = "Reported operating result —";
    const namedRes = verifyQuoteInBody(namedBody, namedQuote);
    expect(namedRes.verified).toBe(true);
    expect(namedBody.slice(namedRes.startOffset, namedRes.endOffset)).toBe(
      "Reported operating result &mdash;",
    );
  });

  it("verifyQuoteInBody handles autolinks and single quotes in URLs without skipping characters", () => {
    const autoBody =
      "Visit <https://example.com> for more information and see [other link](https://test.com) as well.";
    const autoRes = verifyQuoteInBody(
      autoBody,
      "more information and see other link as well.",
    );
    expect(autoRes.verified).toBe(true);
    expect(autoBody.slice(autoRes.startOffset, autoRes.endOffset)).toBe(
      "more information and see [other link](https://test.com) as well.",
    );

    const quoteUrlBody =
      "Check [our query](https://example.com/search?q=don't_stop) for details on the product launch.\n\nNext paragraph has important notes.";
    const quoteUrlRes = verifyQuoteInBody(
      quoteUrlBody,
      "Next paragraph has important notes.",
    );
    expect(quoteUrlRes.verified).toBe(true);
    expect(
      quoteUrlBody.slice(quoteUrlRes.startOffset, quoteUrlRes.endOffset),
    ).toBe("Next paragraph has important notes.");

    const googleBody =
      "[Google](https://example.com/foo'bar) The trial result was negative.";
    const googleRes = verifyQuoteInBody(
      googleBody,
      "The trial result was negative.",
    );
    expect(googleRes.verified).toBe(true);
    expect(googleBody.slice(googleRes.startOffset, googleRes.endOffset)).toBe(
      "The trial result was negative.",
    );
  });

  it("verifyQuoteInBody rejects quotes containing appended hallucinated code blocks", () => {
    const body = "The company reported revenue of $50M for the quarter.";
    const badQuote =
      "The company reported revenue of $50M for the quarter.\n\n```python\nfake_injection_code()\n```";
    expect(verifyQuoteInBody(body, badQuote).verified).toBe(false);
  });

  it("verifyQuoteInBody does not leak code fence language identifier into verified offsets", () => {
    const body =
      'The code example is below:\n\n```python\nprint("hello world")\n```\n';
    const quote = 'print("hello world")';
    const res = verifyQuoteInBody(body, quote);
    expect(res.verified).toBe(true);
    expect(body.slice(res.startOffset, res.endOffset)).toBe(
      'print("hello world")',
    );
  });

  it("verifyQuoteInBody correctly parses reference link shortcuts without leaking link definitions", () => {
    const body =
      "See [target][ref] for info.\n\n[ref]: https://example.com/target";
    const quote = "target for info.";
    const res = verifyQuoteInBody(body, quote);
    expect(res.verified).toBe(true);
    expect(body.slice(res.startOffset, res.endOffset)).toBe(
      "target][ref] for info.",
    );
  });

  it("verifyQuoteInBody respects Unicode code point boundaries including astral plane characters", () => {
    const body = "The initial funding round was 𝟙15 million in capital.";
    const badQuote = "15 million in capital";
    const res = verifyQuoteInBody(body, badQuote);
    expect(res.verified).toBe(false);
  });

  it("evaluateClaimConsensus calculates correct status", () => {
    // Only support
    expect(
      evaluateClaimConsensus([{ verified: true, stance: "support" }]),
    ).toBe("verified");

    // Support and dispute
    expect(
      evaluateClaimConsensus([
        { verified: true, stance: "support" },
        { verified: true, stance: "dispute" },
      ]),
    ).toBe("disputed");

    // Only unverified citations
    expect(
      evaluateClaimConsensus([
        { verified: false, stance: "support" },
        { verified: false, stance: "dispute" },
      ]),
    ).toBe("unverified");

    // Only dispute citations
    expect(
      evaluateClaimConsensus([{ verified: true, stance: "dispute" }]),
    ).toBe("unverified");
  });

  it("isPrimarySourceDomain matches primary domains correctly", () => {
    expect(
      isPrimarySourceDomain("arxiv.org", ["arxiv.org", "nature.com"]),
    ).toBe(true);
    expect(
      isPrimarySourceDomain("cs.arxiv.org", ["arxiv.org", "nature.com"]),
    ).toBe(true);
    expect(
      isPrimarySourceDomain("randomblog.com", ["arxiv.org", "nature.com"]),
    ).toBe(false);
  });
});

describe("generateEventEvidence Integration", () => {
  it("skips generation when an event has no approved articles", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('unapp-ev', 'Unapp Industry', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'No Approved Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const res = await generateEventEvidence(testEnv, event!.id, 1000);
    expect(res.status).toBe("skipped");
    expect((res as { reason: string }).reason).toBe("no_approved_articles");
  });

  it("skips generation and allows retry when any approved article is missing body in R2", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('miss-b-ind', 'Missing Body Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, name, kind, created_at) VALUES (?1, 'https://test.org/feed', 'test.org', 'Test Org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art1 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test.org/1', 'https://test.org/1', 'Article 1', 'sum1', 'sha1', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    const art2 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test.org/2', 'https://test.org/2', 'Article 2', 'sum2', 'sha2', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha1', 'approved', 'auto', 1000), (?2, 'sha2', 'approved', 'auto', 1000)",
    )
      .bind(art1!.id, art2!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Partial Body Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000), (?1, ?3, 1000)",
    )
      .bind(event!.id, art1!.id, art2!.id)
      .run();

    // R2 only has body for art1, art2 is missing
    const partialR2 = new FakeR2();
    partialR2.put(`bodies/${art1!.id}/sha1.md`, "Full text of article 1.");

    const res = await generateEventEvidence(testEnv, event!.id, 1000, {
      bodies: partialR2 as unknown as R2Bucket,
    });

    expect(res.status).toBe("skipped");
    expect((res as { reason: string }).reason).toBe("missing_article_bodies");

    // Verify NO sentinel or claims were inserted, keeping event eligible for retry
    const count = await env.DB.prepare(
      "SELECT count(*) as cnt FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .first<{ cnt: number }>();
    expect(count?.cnt).toBe(0);
  });

  it("propagates Vectorize indexing errors and leaves event eligible for retry without completion sentinels", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('vec-fail-ind', 'Vec Fail Ind', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, name, kind, created_at) VALUES (?1, 'https://test.org/vfeed', 'test.org', 'Test Org', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test.org/v1', 'https://test.org/v1', 'Article Vec', 'sum', 'shaVec', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaVec', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Vec Fail Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const fakeR2 = new FakeR2();
    fakeR2.put(
      `bodies/${art!.id}/shaVec.md`,
      "Full text of article with important facts.",
    );

    // Vectorize throws error
    const failingVectors = {
      upsert: vi
        .fn()
        .mockRejectedValue(new Error("Vectorize temporary outage")),
    };

    const transport = makeFakeTransport(() => ({}));

    await expect(
      generateEventEvidence(testEnv, event!.id, 1000, {
        transport,
        bodies: fakeR2 as unknown as R2Bucket,
        vectors: failingVectors as unknown as Pick<VectorizeIndex, "upsert">,
      }),
    ).rejects.toThrow("Vectorize temporary outage");

    // Sentinel must NOT be written, event must remain eligible for retry
    const count = await env.DB.prepare(
      "SELECT count(*) as cnt FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .first<{ cnt: number }>();
    expect(count?.cnt).toBe(0);
  });

  it("extracts, verifies, and indexes claims & evidence", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, primary_domains, created_at) VALUES ('tech-ev', 'Tech Evidence', 'auto', '[\"whitehouse.gov\"]', 1000) RETURNING id",
    ).first<{ id: number }>();

    const src1 = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, name, kind, created_at) VALUES (?1, 'https://whitehouse.gov/feed', 'whitehouse.gov', 'White House', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const src2 = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, name, kind, created_at) VALUES (?1, 'https://techblog.com/feed', 'techblog.com', 'Tech Blog', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const body1 =
      "The administration announced a national investment of $500 million for quantum testbeds across five universities.";
    const body2 =
      "Industry analysts dispute the timeline, claiming that funding will only reach $200 million this fiscal year.";

    const art1 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://whitehouse.gov/quantum', 'https://whitehouse.gov/quantum', 'National Quantum Initiative', 'WH summary', 'shaWH', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src1!.id, ind!.id)
      .first<{ id: number }>();

    const art2 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://techblog.com/quantum', 'https://techblog.com/quantum', 'Quantum Funding Reality Check', 'Blog summary', 'shaTB', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src2!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaWH', 'approved', 'auto', 1000)",
    )
      .bind(art1!.id)
      .run();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaTB', 'approved', 'auto', 1000)",
    )
      .bind(art2!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Quantum Investment Event', 1, 1000, 1000) RETURNING id",
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

    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art1!.id}/shaWH.md`, body1);
    fakeR2.put(`bodies/${art2!.id}/shaTB.md`, body2);

    const fakeVectors = new FakeVectors();

    const transport = makeFakeTransport((_model, _input) => ({
      claims: [
        {
          claimText:
            "National investment will allocate $500M to quantum testbeds.",
          claimType: "fact",
          citations: [
            {
              articleId: art1!.id,
              quote:
                "The administration announced a national investment of $500 million for quantum testbeds across five universities.",
              stance: "support",
            },
            {
              articleId: art2!.id,
              quote:
                "Industry analysts dispute the timeline, claiming that funding will only reach $200 million this fiscal year.",
              stance: "dispute",
            },
          ],
        },
      ],
    }));

    const res = await generateEventEvidence(testEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: fakeVectors as unknown as Pick<VectorizeIndex, "upsert">,
    });

    expect(res.status).toBe("generated");
    if (res.status === "generated") {
      expect(res.claimsCount).toBe(1);
      expect(res.citationsCount).toBe(2);
    }

    // Verify vectors were upserted to V_CHUNKS
    expect(fakeVectors.records.length).toBeGreaterThanOrEqual(2);

    // Verify D1 records
    const claimRow = await env.DB.prepare(
      "SELECT id, claim_text, claim_type, consensus_status, primary_source_preferred, status FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .first<{
        id: number;
        claim_text: string;
        claim_type: string;
        consensus_status: string;
        primary_source_preferred: number;
        status: string;
      }>();

    expect(claimRow).toBeDefined();
    expect(claimRow?.claim_type).toBe("fact");
    // Support and dispute both verified -> disputed
    expect(claimRow?.consensus_status).toBe("disputed");
    expect(claimRow?.primary_source_preferred).toBe(1); // whitehouse.gov is in primary_domains
    expect(claimRow?.status).toBe("published"); // auto publish mode

    const citationRows = await env.DB.prepare(
      "SELECT article_id, stance, is_primary_source, verified, start_offset, end_offset FROM claim_evidence WHERE claim_id = ?1 ORDER BY is_primary_source DESC",
    )
      .bind(claimRow!.id)
      .all<{
        article_id: number;
        stance: string;
        is_primary_source: number;
        verified: number;
        start_offset: number;
        end_offset: number;
      }>();

    expect(citationRows.results).toHaveLength(2);
    expect(citationRows.results[0].article_id).toBe(art1!.id);
    expect(citationRows.results[0].is_primary_source).toBe(1);
    expect(citationRows.results[0].verified).toBe(1);
    expect(citationRows.results[0].stance).toBe("support");

    expect(citationRows.results[1].article_id).toBe(art2!.id);
    expect(citationRows.results[1].is_primary_source).toBe(0);
    expect(citationRows.results[1].verified).toBe(1);
    expect(citationRows.results[1].stance).toBe("dispute");
  });

  it("enforces Finance section guardrails: initial status is pending_review", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('finance', 'Finance', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://sec.gov/feed', 'sec.gov', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const body = "Company reported quarterly net income of $42.5 million.";
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://sec.gov/10q', 'https://sec.gov/10q', 'SEC 10-Q Filing', 'Filing summary', 'shaSEC', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaSEC', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Earnings Filing Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art!.id}/shaSEC.md`, body);

    const transport = makeFakeTransport((_model, _input) => ({
      claims: [
        {
          claimText: "Quarterly net income was $42.5M.",
          claimType: "fact",
          citations: [
            {
              articleId: art!.id,
              quote: "Company reported quarterly net income of $42.5 million.",
              stance: "support",
            },
          ],
        },
      ],
    }));

    const res = await generateEventEvidence(testEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
    });

    expect(res.status).toBe("generated");

    const claimRow = await env.DB.prepare(
      "SELECT status FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .first<{ status: string }>();

    // Mandatory Finance rule: must be pending_review!
    expect(claimRow?.status).toBe("pending_review");
  });

  it("protects against revision race conditions: does not insert if event revision changed", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('race-ev', 'Race Evidence', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://test/feed', 'test.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const body = "Autonomous AI agents were deployed across all branches.";
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test/race', 'https://test/race', 'Race Article', 'Race summary', 'shaRace', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaRace', 'approved', 'auto', 1000)",
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

    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art!.id}/shaRace.md`, body);

    // Simulate concurrent event revision bump right during model call
    const transport = makeFakeTransport((_model, _input) => {
      // Simulate admin or grouping incrementing revision to 2
      env.DB.prepare("UPDATE events SET revision = 2 WHERE id = ?1")
        .bind(event!.id)
        .run();
      return {
        claims: [
          {
            claimText:
              "Autonomous AI agents were deployed across all branches.",
            claimType: "fact",
            citations: [
              {
                articleId: art!.id,
                quote:
                  "Autonomous AI agents were deployed across all branches.",
                stance: "support",
              },
            ],
          },
        ],
      };
    });

    const res = await generateEventEvidence(testEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
    });

    expect(res.status).toBe("generated");
    if (res.status === "generated") {
      // 0 claims inserted because revision condition failed
      expect(res.claimsCount).toBe(0);
    }

    const count = await env.DB.prepare(
      "SELECT count(*) as count FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("is idempotent: repeated invocation on same revision makes 0 duplicate calls", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('idemp-ev', 'Idempotent Evidence', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://test/idemp', 'test.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const body = "Verified quantum error correction demonstration.";
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test/idemp', 'https://test/idemp', 'Quantum Error Correction', 'Summary', 'shaQEC', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaQEC', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'QEC Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art!.id}/shaQEC.md`, body);

    let modelCalls = 0;
    const transport = makeFakeTransport((_model, _input) => {
      modelCalls++;
      return {
        claims: [
          {
            claimText: "Verified quantum error correction demonstration.",
            claimType: "fact",
            citations: [
              {
                articleId: art!.id,
                quote: "Verified quantum error correction demonstration.",
                stance: "support",
              },
            ],
          },
        ],
      };
    });

    const res1 = await generateEventEvidence(testEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
    });
    expect(res1.status).toBe("generated");
    expect(modelCalls).toBe(1);

    // Second call: must skip and make 0 model calls!
    const res2 = await generateEventEvidence(testEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
    });
    expect(res2.status).toBe("skipped");
    expect((res2 as { reason: string }).reason).toBe("already_exists");
    expect(modelCalls).toBe(1);
  });
});

describe("enqueueDueEvidence & handleGenerateBatch", () => {
  it("enqueues events with approved articles missing claims", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('sched-ev', 'Sched Evidence', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://test/feed', 'test.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test/sched', 'https://test/sched', 'Sched Article', 'Summary', 'shaSched', 1000, 'grouped', 1000)
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
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Sched Due Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const fakeQueue = new FakeQueue();
    const enqueued = await enqueueDueEvidence(
      { DB: env.DB, Q_GENERATE: fakeQueue as unknown as Queue },
      1000,
      10,
    );

    expect(enqueued).toContain(event!.id);
    expect(fakeQueue.sent).toContainEqual({
      kind: "evidence",
      eventId: event!.id,
    });
  });

  it("handles evidence message in handleGenerateBatch", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('batch-ev', 'Batch Evidence', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://test/feed', 'test.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const body = "Verified batch test quotation for evidence generation.";
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://test/batch', 'https://test/batch', 'Batch Article', 'Summary', 'shaBatch', 1000, 'grouped', 1000)
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
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Batch Evidence Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art!.id}/shaBatch.md`, body);

    const transport = makeFakeTransport((_model, _input) => ({
      claims: [
        {
          claimText: "Verified batch test quotation for evidence generation.",
          claimType: "fact",
          citations: [
            {
              articleId: art!.id,
              quote: "Verified batch test quotation for evidence generation.",
              stance: "support",
            },
          ],
        },
      ],
    }));

    let acked = false;
    const msg: Message<GenerateMessage> = {
      id: "msg-ev-1",
      timestamp: new Date(),
      body: { kind: "evidence", eventId: event!.id },
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

    const envWithR2: PipelineEnv = {
      ...testEnv,
      BODIES: fakeR2 as unknown as R2Bucket,
    };

    await handleGenerateBatch(batch, envWithR2, { transport });
    expect(acked).toBe(true);

    const claimRow = await env.DB.prepare(
      "SELECT id FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .first<{ id: number }>();
    expect(claimRow).toBeDefined();
  });

  it("handles empty claims array by storing NO_CLAIMS_SENTINEL and filters out of publication and schedule", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('auto-empty-claims-ind', 'Auto Empty', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://empty/feed', 'empty.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-empty', 'https://example.com/art-empty', 'Empty Claims Article', 'Summary', 'shaEmpty', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaEmpty', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Empty Claims Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const fakeR2 = new FakeR2();
    fakeR2.put(
      `bodies/${art!.id}/shaEmpty.md`,
      "Paragraph with no verifiable statistical or factual claims.",
    );

    const transport = makeFakeTransport((_model, _input) => ({
      claims: [],
    }));

    const queue = new FakeQueue();
    const vectors = new FakeVectors();

    const pipelineEnv: PipelineEnv = {
      ...testEnv,
      BODIES: fakeR2 as unknown as R2Bucket,
      Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"],
      V_CHUNKS: vectors as unknown as PipelineEnv["V_CHUNKS"],
    };

    const res = await generateEventEvidence(pipelineEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: vectors as unknown as Pick<VectorizeIndex, "upsert">,
    });
    expect(res.status).toBe("generated");
    if (res.status === "generated") {
      expect(res.claimsCount).toBe(0);
    }

    // Verify database has sentinel claim
    const rows = await env.DB.prepare(
      "SELECT claim_text, status FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ claim_text: string; status: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].claim_text).toBe("[no_verifiable_claims]");

    // Verify publication layer ignores sentinel claim
    const pubEvidence = await getEventEvidence(getDb(env.DB), event!.id);
    expect(pubEvidence.claims).toHaveLength(0);

    // Verify enqueueDueEvidence skips the event because sentinel completes it
    const enqueued = await enqueueDueEvidence(
      { DB: env.DB, Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"] },
      1000,
    );
    expect(enqueued).not.toContain(event!.id);
    expect(queue.sent).not.toContainEqual({
      kind: "evidence",
      eventId: event!.id,
    });
  });

  it("recovers from interrupted/dirty batch by cleaning up uncompleted claims on retry", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('auto-dirty-claims-ind', 'Auto Dirty', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://dirty/feed', 'dirty.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-dirty', 'https://example.com/art-dirty', 'Dirty Recovery Article', 'Summary', 'shaDirty', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaDirty', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Dirty Claims Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const quoteText =
      "Recovery test quotation showing self healing dirty cleanup.";
    const bodyText = `Intro line.\n\n${quoteText}\n\nOutro line.`;
    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art!.id}/shaDirty.md`, bodyText);

    // Simulate an interrupted run: a dirty claim exists without the completion sentinel
    const dirtyClaim = await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 1, 'pv-old', 'model-dirty', 'Unfinished partial claim from prior run', 'fact', 'unverified', 'pending_review', 0, 1000)
       RETURNING id`,
    )
      .bind(event!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, quote, quote_clean, start_offset, end_offset, stance, is_primary_source, verified, created_at)
       VALUES (?1, ?2, 'shaDirty', 'Partial quote', 'Partial quote', 0, 10, 'support', 0, 0, 1000)`,
    )
      .bind(dirtyClaim!.id, art!.id)
      .run();

    const queue = new FakeQueue();
    const vectors = new FakeVectors();

    // 1. enqueueDueEvidence considers it due because [evidence_batch_complete] is missing
    const enqueued = await enqueueDueEvidence(
      { DB: env.DB, Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"] },
      1000,
    );
    expect(enqueued).toContain(event!.id);
    expect(queue.sent).toContainEqual({ kind: "evidence", eventId: event!.id });

    // 2. generateEventEvidence runs: it must clean up the dirty claim and citations
    const transport = makeFakeTransport((_model, _input) => ({
      claims: [
        {
          claimText: quoteText,
          claimType: "fact",
          citations: [
            {
              articleId: art!.id,
              quote: quoteText,
              stance: "support",
            },
          ],
        },
      ],
    }));

    const pipelineEnv: PipelineEnv = {
      ...testEnv,
      BODIES: fakeR2 as unknown as R2Bucket,
      Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"],
      V_CHUNKS: vectors as unknown as PipelineEnv["V_CHUNKS"],
    };

    const res = await generateEventEvidence(pipelineEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: vectors as unknown as Pick<VectorizeIndex, "upsert">,
    });
    expect(res.status).toBe("generated");
    if (res.status === "generated") {
      expect(res.claimsCount).toBe(1);
    }

    // Old dirty claim should be gone
    const oldDirty = await env.DB.prepare("SELECT id FROM claims WHERE id = ?1")
      .bind(dirtyClaim!.id)
      .first();
    expect(oldDirty).toBeNull();

    // Now we have the new claim + [evidence_batch_complete] sentinel
    const allClaims = await env.DB.prepare(
      "SELECT claim_text, status FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ claim_text: string; status: string }>();
    expect(allClaims.results).toHaveLength(2);
    const texts = allClaims.results.map((r) => r.claim_text);
    expect(texts).toContain(quoteText);
    expect(texts).toContain("[evidence_batch_complete]");

    // 3. Next enqueueDueEvidence skips the event because sentinel is present
    queue.sent = [];
    const enqueuedAfter = await enqueueDueEvidence(
      { DB: env.DB, Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"] },
      1000,
    );
    expect(enqueuedAfter).not.toContain(event!.id);
    expect(queue.sent).not.toContainEqual({
      kind: "evidence",
      eventId: event!.id,
    });
  });

  it("does not lock into broken cache when model output fails schema validation, allowing retry", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('auto-bad-output-ind', 'Auto Bad Output', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://bad/feed', 'bad.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-bad', 'https://example.com/art-bad', 'Bad Output Article', 'Summary', 'shaBad', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaBad', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const quoteText = "Valid quote for retry test after invalid model output.";
    const bodyText = `Intro line.\n\n${quoteText}\n\nOutro line.`;
    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art!.id}/shaBad.md`, bodyText);

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Bad Output Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const queue = new FakeQueue();
    const vectors = new FakeVectors();

    let callsCount = 0;
    // Transport returns invalid non-JSON output on first call, valid claims on second call
    const dynamicTransport: ModelTransport = {
      run: async (model: string, _input: unknown) => {
        if (model === "@cf/baai/bge-m3") {
          return { shape: [1, 3], data: [[0.1, 0.2, 0.3]] };
        }
        callsCount++;
        if (callsCount === 1) {
          return {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "MALFORMED NON-JSON TEXT" }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 50,
              candidatesTokenCount: 10,
              totalTokenCount: 60,
            },
          };
        }
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      claims: [
                        {
                          claimText: quoteText,
                          claimType: "fact",
                          citations: [
                            {
                              articleId: art!.id,
                              quote: quoteText,
                              stance: "support",
                            },
                          ],
                        },
                      ],
                    }),
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 50,
            totalTokenCount: 100,
          },
        };
      },
    };

    const pipelineEnv: PipelineEnv = {
      ...testEnv,
      BODIES: fakeR2 as unknown as R2Bucket,
      Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"],
      V_CHUNKS: vectors as unknown as PipelineEnv["V_CHUNKS"],
    };

    // Attempt 1: model returns malformed text -> returns skipped, does not write sentinel, records failure in llm_calls
    const res1 = await generateEventEvidence(pipelineEnv, event!.id, 1000, {
      transport: dynamicTransport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: vectors as unknown as Pick<VectorizeIndex, "upsert">,
    });
    expect(res1.status).toBe("skipped");
    if (res1.status === "skipped") {
      expect(res1.reason).toBe("failed_to_parse_model_output");
    }

    // Verify llm_calls has status = 'failed' (NOT 'completed')
    const llmRow = await env.DB.prepare(
      "SELECT status, error FROM llm_calls WHERE slot = 'reason' ORDER BY id DESC LIMIT 1",
    ).first<{ status: string; error: string }>();
    expect(llmRow?.status).toBe("failed");
    expect(llmRow?.error).toContain("failed to parse claims output");

    // Attempt 2: retry -> calls transport again (callsCount becomes 2), succeeds, writes claims
    const res2 = await generateEventEvidence(pipelineEnv, event!.id, 2000, {
      transport: dynamicTransport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: vectors as unknown as Pick<VectorizeIndex, "upsert">,
    });
    expect(res2.status).toBe("generated");
    if (res2.status === "generated") {
      expect(res2.claimsCount).toBe(1);
    }
    expect(callsCount).toBe(2);

    // Verify claims now successfully populated
    const claims = await env.DB.prepare(
      "SELECT claim_text FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ claim_text: string }>();
    expect(claims.results.map((c) => c.claim_text)).toContain(quoteText);
  });

  it("atomically protects against concurrent tasks attempting cleanup on completed batches", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('auto-race-ind', 'Auto Race', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://race/feed', 'race.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-race', 'https://example.com/art-race', 'Race Article', 'Summary', 'shaRace', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaRace', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const quoteText =
      "Race protection quotation ensuring citations never get orphaned.";
    const bodyText = `Intro line.\n\n${quoteText}\n\nOutro line.`;
    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art!.id}/shaRace.md`, bodyText);

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

    const queue = new FakeQueue();
    const vectors = new FakeVectors();

    const transport = makeFakeTransport((_model, _input) => ({
      claims: [
        {
          claimText: quoteText,
          claimType: "fact",
          citations: [
            { articleId: art!.id, quote: quoteText, stance: "support" },
          ],
        },
      ],
    }));

    const pipelineEnv: PipelineEnv = {
      ...testEnv,
      BODIES: fakeR2 as unknown as R2Bucket,
      Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"],
      V_CHUNKS: vectors as unknown as PipelineEnv["V_CHUNKS"],
    };

    // Task A runs and commits the atomic batch
    const resA = await generateEventEvidence(pipelineEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: vectors as unknown as Pick<VectorizeIndex, "upsert">,
    });
    expect(resA.status).toBe("generated");
    if (resA.status === "generated") {
      expect(resA.claimsCount).toBe(1);
      expect(resA.citationsCount).toBe(1);
    }

    // Task B runs concurrently / afterwards on same revision
    const resB = await generateEventEvidence(pipelineEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: vectors as unknown as Pick<VectorizeIndex, "upsert">,
    });
    expect(resB.status).toBe("skipped");
    if (resB.status === "skipped") {
      expect(resB.reason).toBe("already_exists");
    }

    // Verify Task A's citations and claims are 100% intact (citations count = 1, claims count = 2 including complete sentinel)
    const claimRows = await env.DB.prepare(
      "SELECT id, claim_text FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .all<{ id: number; claim_text: string }>();
    expect(claimRows.results).toHaveLength(2);

    const factClaim = claimRows.results.find((c) => c.claim_text === quoteText);
    expect(factClaim).toBeDefined();

    const citationRows = await env.DB.prepare(
      "SELECT id, quote FROM claim_evidence WHERE claim_id = ?1",
    )
      .bind(factClaim!.id)
      .all<{ id: number; quote: string }>();
    expect(citationRows.results).toHaveLength(1);
    expect(citationRows.results[0].quote).toBe(quoteText);
  });

  it("rejects model outputs containing reserved bracket sentinels", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('auto-impostor-ind', 'Auto Impostor', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://impostor/feed', 'impostor.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-impostor', 'https://example.com/art-impostor', 'Impostor Article', 'Summary', 'shaImpostor', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaImpostor', 'approved', 'auto', 1000)",
    )
      .bind(art!.id)
      .run();

    const fakeR2 = new FakeR2();
    fakeR2.put(
      `bodies/${art!.id}/shaImpostor.md`,
      "Paragraph text here for testing.",
    );

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Impostor Event', 1, 1000, 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();

    const queue = new FakeQueue();
    const vectors = new FakeVectors();

    // Model tries to emit [evidence_batch_complete] as a fake claim
    const transport = makeFakeTransport((_model, _input) => ({
      claims: [
        {
          claimText: "[evidence_batch_complete]",
          claimType: "fact",
          citations: [
            {
              articleId: art!.id,
              quote: "Paragraph text here for testing.",
              stance: "support",
            },
          ],
        },
      ],
    }));

    const pipelineEnv: PipelineEnv = {
      ...testEnv,
      BODIES: fakeR2 as unknown as R2Bucket,
      Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"],
      V_CHUNKS: vectors as unknown as PipelineEnv["V_CHUNKS"],
    };

    const res = await generateEventEvidence(pipelineEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: vectors as unknown as Pick<VectorizeIndex, "upsert">,
    });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("failed_to_parse_model_output");
    }

    // Verify nothing written to claims
    const count = await env.DB.prepare(
      "SELECT count(*) as count FROM claims WHERE event_id = ?1",
    )
      .bind(event!.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("merges duplicate claims and combines citations before evaluating consensus", async () => {
    await ensureBudget();
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('auto-dup-ind', 'Auto Dup', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src1 = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://dup1/feed', 'dup1.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    const src2 = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://dup2/feed', 'dup2.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art1 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-dup1', 'https://example.com/art-dup1', 'Dup Article 1', 'Summary', 'shaDup1', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src1!.id, ind!.id)
      .first<{ id: number }>();

    const art2 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-dup2', 'https://example.com/art-dup2', 'Dup Article 2', 'Summary', 'shaDup2', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src2!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaDup1', 'approved', 'auto', 1000)",
    )
      .bind(art1!.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaDup2', 'approved', 'auto', 1000)",
    )
      .bind(art2!.id)
      .run();

    const quoteSupport =
      "The ministry announced an initial grant of $100 million for solar grid research.";
    const quoteDispute =
      "Financial auditors dispute the grant figure, asserting that only $20 million was disbursed.";
    const fakeR2 = new FakeR2();
    fakeR2.put(`bodies/${art1!.id}/shaDup1.md`, quoteSupport);
    fakeR2.put(`bodies/${art2!.id}/shaDup2.md`, quoteDispute);

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Dup Event', 1, 1000, 1000) RETURNING id",
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

    const queue = new FakeQueue();
    const vectors = new FakeVectors();

    const sharedClaimText =
      "Government allocated funding for renewable solar grid.";

    // Model outputs the same claimText twice: once with support, once with dispute
    const transport = makeFakeTransport((_model, _input) => ({
      claims: [
        {
          claimText: sharedClaimText,
          claimType: "fact",
          citations: [
            { articleId: art1!.id, quote: quoteSupport, stance: "support" },
          ],
        },
        {
          claimText: sharedClaimText,
          claimType: "fact",
          citations: [
            { articleId: art2!.id, quote: quoteDispute, stance: "dispute" },
          ],
        },
      ],
    }));

    const pipelineEnv: PipelineEnv = {
      ...testEnv,
      BODIES: fakeR2 as unknown as R2Bucket,
      Q_GENERATE: queue as unknown as PipelineEnv["Q_GENERATE"],
      V_CHUNKS: vectors as unknown as PipelineEnv["V_CHUNKS"],
    };

    const res = await generateEventEvidence(pipelineEnv, event!.id, 1000, {
      transport,
      bodies: fakeR2 as unknown as R2Bucket,
      vectors: vectors as unknown as Pick<VectorizeIndex, "upsert">,
    });
    expect(res.status).toBe("generated");
    if (res.status === "generated") {
      expect(res.claimsCount).toBe(1); // Merged into 1 claim!
      expect(res.citationsCount).toBe(2); // Both citations inserted!
    }

    // Verify consensus_status correctly reflects the combination of support + dispute -> 'disputed'
    const storedClaim = await env.DB.prepare(
      "SELECT id, claim_text, consensus_status FROM claims WHERE event_id = ?1 AND claim_text = ?2",
    )
      .bind(event!.id, sharedClaimText)
      .first<{ id: number; claim_text: string; consensus_status: string }>();
    expect(storedClaim).toBeDefined();
    expect(storedClaim?.consensus_status).toBe("disputed");

    // Verify both citations are linked to this claim
    const citations = await env.DB.prepare(
      "SELECT stance FROM claim_evidence WHERE claim_id = ?1",
    )
      .bind(storedClaim!.id)
      .all<{ stance: string }>();
    expect(citations.results).toHaveLength(2);
    const stances = citations.results.map((c) => c.stance);
    expect(stances).toContain("support");
    expect(stances).toContain("dispute");
  });

  it("getEventEvidence returns atomically consistent claims and evidence and respects event revision", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('atomic-ev-ind', 'Atomic Ev', 'auto', 1000) RETURNING id",
    ).first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, 'https://atomic/feed', 'atomic.com', 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const art1 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-atomic-1', 'https://example.com/art-atomic-1', 'Atomic Article 1', 'Summary', 'shaAtomic1', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    const art2 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, 'https://example.com/art-atomic-2', 'https://example.com/art-atomic-2', 'Atomic Article 2', 'Summary', 'shaAtomic2', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(src!.id, ind!.id)
      .first<{ id: number }>();

    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'shaAtomic1', 'approved', 'auto', 1000)",
    )
      .bind(art1!.id)
      .run();

    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Atomic Evidence Event', 1, 1000, 1000) RETURNING id",
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

    // Insert published claim for revision 1
    const claim = await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, primary_source_preferred, status, created_at)
       VALUES (?1, 1, 'test-prompt-v1', 'test-model', 'Atomic Claim Text', 'fact', 'verified', 0, 'published', 1000) RETURNING id`,
    )
      .bind(event!.id)
      .first<{ id: number }>();

    // Insert valid citation for approved article 1
    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, quote, quote_clean, start_offset, end_offset, stance, is_primary_source, verified, created_at)
       VALUES (?1, ?2, 'shaAtomic1', 'Quote 1', 'Quote 1', 0, 10, 'support', 1, 1, 1000)`,
    )
      .bind(claim!.id, art1!.id)
      .run();

    // Insert citation for unapproved article 2
    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, quote, quote_clean, start_offset, end_offset, stance, is_primary_source, verified, created_at)
       VALUES (?1, ?2, 'shaAtomic2', 'Quote 2', 'Quote 2', 0, 10, 'support', 0, 1, 1000)`,
    )
      .bind(claim!.id, art2!.id)
      .run();

    // Query publication layer
    const view1 = await getEventEvidence(getDb(env.DB), event!.id);
    expect(view1.claims).toHaveLength(1);
    expect(view1.claims[0].id).toBe(claim!.id);
    // Only approved article 1 evidence should be included, unapproved article 2 evidence excluded
    expect(view1.claims[0].evidence).toHaveLength(1);
    expect(view1.claims[0].evidence[0].articleId).toBe(art1!.id);
    expect(view1.claims[0].evidence[0].articleUrl).toBe(
      "https://example.com/art-atomic-1",
    );

    // If event revision changes to 2, old revision 1 claim should not be returned
    await env.DB.prepare("UPDATE events SET revision = 2 WHERE id = ?1")
      .bind(event!.id)
      .run();
    const view2 = await getEventEvidence(getDb(env.DB), event!.id);
    expect(view2.claims).toHaveLength(0);
  });
});
