import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { generateEventEvidence } from "../../src/pipeline/evidence/build";
import { chunkMarkdownBody } from "../../src/pipeline/evidence/chunks";
import { enqueueDueEvidence } from "../../src/pipeline/evidence/schedule";
import {
  evaluateClaimConsensus,
  isPrimarySourceDomain,
  verifyQuoteInBody,
} from "../../src/pipeline/evidence/verify";
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
});
