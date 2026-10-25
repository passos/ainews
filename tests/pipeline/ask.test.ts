import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  ASK_QUESTION_MAX_COST_MICROS,
} from "../../src/pipeline/ask/answer";
import { handleGenerateBatch } from "../../src/pipeline/generate/consumer";
import type { GenerateMessage } from "../../src/pipeline/messages";
import type { ModelTransport } from "../../src/providers/transport";

class FakeVectors {
  records: Array<{
    id: string;
    values: number[];
    metadata: Record<string, unknown>;
  }> = [];

  async query(
    _vector: number[],
    _options?: { topK?: number; returnMetadata?: string },
  ) {
    return {
      matches: this.records.map((r) => ({
        id: r.id,
        score: 0.95,
        metadata: r.metadata,
      })),
    };
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
      const resp = await responder(model, input);
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

async function seedTestCorpus() {
  await ensureBudget();

  // Create Industry
  await env.DB.prepare(
    `INSERT OR IGNORE INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
     VALUES (101, 'technology', 'Technology', 'review', '["arxiv.org", "technologyreview.com"]', '{}', 1, 1000)`,
  ).run();

  // Create Sources
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sources (id, industry_id, name, site_domain, feed_url, kind, status, config, created_at)
     VALUES (201, 101, 'arXiv cs.AI', 'arxiv.org', 'https://rss.arxiv.org/rss/cs.AI', 'rss', 'active', '{}', 1000)`,
  ).run();

  // Create Event
  await env.DB.prepare(
    `INSERT OR IGNORE INTO events (id, industry_id, title, revision, created_at, updated_at)
     VALUES (301, 101, 'DeepSeek-R1 Architecture Paper', 1, 1000, 1000)`,
  ).run();
}

describe("Ask Newsren Pipeline", () => {
  it("answers question with verbatim verified citations when evidence is sufficient", async () => {
    await seedTestCorpus();

    const bodyText =
      "DeepSeek-R1 introduces open reasoning capabilities.\n\nThe benchmark demonstrates a 79.8% pass rate on AIME 2024 competitions without human intervention.\n\nResearchers confirmed reproduction in open models.";
    const bodySha = "sha_deepseek_798";
    const artId = 401;

    // Insert article
    await env.DB.prepare(
      `INSERT OR REPLACE INTO articles (id, industry_id, source_id, title, url, canonical_url, body_sha, body_kind, stage, stage_updated_at, published_at, fetched_at)
       VALUES (?1, 101, 201, 'DeepSeek-R1 Benchmark Report', 'https://arxiv.org/abs/2501.12948', 'https://arxiv.org/abs/2501.12948', ?2, 'full', 'grouped', 1000, 1000, 1000)`,
    )
      .bind(artId, bodySha)
      .run();

    // Mark approved in reviews
    await env.DB.prepare(
      `INSERT OR REPLACE INTO reviews (id, article_id, body_sha, decision, reviewer, created_at)
       VALUES (501, ?1, ?2, 'approved', 'admin@example.com', 1000)`,
    )
      .bind(artId, bodySha)
      .run();

    // Link to event
    await env.DB.prepare(
      `INSERT OR REPLACE INTO event_articles (event_id, article_id, created_at)
       VALUES (301, ?1, 1000)`,
    )
      .bind(artId)
      .run();

    // Fake R2 with article body
    const r2 = new FakeR2();
    r2.put(`bodies/${artId}/${bodySha}.md`, bodyText);

    // Fake Vectorize with chunk metadata
    const vectors = new FakeVectors();
    vectors.records.push({
      id: `c_${artId}_0`,
      values: [0.1, 0.2, 0.3],
      metadata: { article_id: artId, body_sha: bodySha },
    });

    // Create question in D1
    const qRes = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status, prompt_version, model, created_at)
       VALUES ('What is the reported AIME 2024 pass rate for DeepSeek-R1?', 'global', NULL, 'pending', 'ask:v1', 'default', 1000)`,
    ).run();
    const questionId = Number(qRes.meta.last_row_id);

    // Model transport responder
    const transport = makeFakeTransport((_model, _input) => {
      return {
        sufficient: true,
        neededUrls: [],
        answer:
          "DeepSeek-R1 achieves a 79.8% pass rate on AIME 2024 benchmarks.",
        unverified: [],
        citations: [
          {
            articleId: artId,
            quote:
              "The benchmark demonstrates a 79.8% pass rate on AIME 2024 competitions without human intervention.",
            claim: "DeepSeek-R1 achieves 79.8% on AIME 2024",
          },
        ],
      };
    });

    const result = await answerQuestion(
      { ...env, MODEL_CALLS_ENABLED: "true" },
      questionId,
      1000,
      {
        bodies: r2 as unknown as R2Bucket,
        vectors: vectors as unknown as Pick<VectorizeIndex, "query">,
        transport,
      },
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.refusal).toBe(false);
      expect(result.citationsCount).toBe(1);
    }

    // Verify row in D1
    const row = await env.DB.prepare(`SELECT * FROM questions WHERE id = ?1`)
      .bind(questionId)
      .first<{
        status: string;
        answer: string;
        refusal: number;
        citations: string;
        unverified: string;
      }>();

    expect(row?.status).toBe("completed");
    expect(row?.refusal).toBe(0);
    expect(row?.answer).toContain("79.8% pass rate");
    const citations = JSON.parse(row?.citations ?? "[]");
    expect(citations.length).toBe(1);
    expect(citations[0].verified).toBe(true);
    expect(citations[0].isPrimarySource).toBe(true);
    expect(citations[0].startOffset).toBeGreaterThan(0);
  });

  it("filters out unapproved articles from retrieval context", async () => {
    await seedTestCorpus();

    const bodyText =
      "Confidential unreviewed leak about model performance reaching 99%.";
    const bodySha = "sha_unapproved_leak";
    const artId = 402;

    await env.DB.prepare(
      `INSERT OR REPLACE INTO articles (id, industry_id, source_id, title, url, canonical_url, body_sha, body_kind, stage, stage_updated_at, published_at, fetched_at)
       VALUES (?1, 101, 201, 'Leaked Model Rumors', 'https://arxiv.org/abs/leak', 'https://arxiv.org/abs/leak', ?2, 'full', 'collected', 1000, 1000, 1000)`,
    )
      .bind(artId, bodySha)
      .run();

    // Mark REJECTED in reviews
    await env.DB.prepare(
      `INSERT OR REPLACE INTO reviews (id, article_id, body_sha, decision, reviewer, created_at)
       VALUES (502, ?1, ?2, 'rejected', 'admin@example.com', 1000)`,
    )
      .bind(artId, bodySha)
      .run();

    const r2 = new FakeR2();
    r2.put(`bodies/${artId}/${bodySha}.md`, bodyText);

    // Vectorize has the chunk
    const vectors = new FakeVectors();
    vectors.records.push({
      id: `c_${artId}_0`,
      values: [0.1, 0.2, 0.3],
      metadata: { article_id: artId, body_sha: bodySha },
    });

    const qRes = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status, prompt_version, model, created_at)
       VALUES ('What is the leaked 99% performance?', 'global', NULL, 'pending', 'ask:v1', 'default', 1000)`,
    ).run();
    const questionId = Number(qRes.meta.last_row_id);

    let promptSeen = "";
    const transport = makeFakeTransport((_model, input) => {
      promptSeen = JSON.stringify(input);
      return {
        sufficient: false,
        neededUrls: [],
        answer: "No verified reports in the database support this claim.",
        unverified: ["Unreviewed rumors about 99% performance"],
        citations: [],
      };
    });

    const result = await answerQuestion(
      { ...env, MODEL_CALLS_ENABLED: "true" },
      questionId,
      1000,
      {
        bodies: r2 as unknown as R2Bucket,
        vectors: vectors as unknown as Pick<VectorizeIndex, "query">,
        transport,
      },
    );

    // The unapproved article text must NEVER be fed into the prompt!
    expect(promptSeen).not.toContain("Confidential unreviewed leak");
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.refusal).toBe(true);
    }

    const row = await env.DB.prepare(`SELECT * FROM questions WHERE id = ?1`)
      .bind(questionId)
      .first<{ refusal: number }>();
    expect(row?.refusal).toBe(1);
  });

  it("detects tampered citations and refuses unsupported assertions", async () => {
    await seedTestCorpus();

    const bodyText =
      "The clinical trial demonstrated no significant benefit in patients with stage IV illness.";
    const bodySha = "sha_trial_no_benefit";
    const artId = 403;

    await env.DB.prepare(
      `INSERT OR REPLACE INTO articles (id, industry_id, source_id, title, url, canonical_url, body_sha, body_kind, stage, stage_updated_at, published_at, fetched_at)
       VALUES (?1, 101, 201, 'Trial Findings', 'https://arxiv.org/abs/trial', 'https://arxiv.org/abs/trial', ?2, 'full', 'grouped', 1000, 1000, 1000)`,
    )
      .bind(artId, bodySha)
      .run();

    await env.DB.prepare(
      `INSERT OR REPLACE INTO reviews (id, article_id, body_sha, decision, reviewer, created_at)
       VALUES (503, ?1, ?2, 'approved', 'admin@example.com', 1000)`,
    )
      .bind(artId, bodySha)
      .run();

    const r2 = new FakeR2();
    r2.put(`bodies/${artId}/${bodySha}.md`, bodyText);

    const vectors = new FakeVectors();
    vectors.records.push({
      id: `c_${artId}_0`,
      values: [0.1, 0.2, 0.3],
      metadata: { article_id: artId, body_sha: bodySha },
    });

    const qRes = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status, prompt_version, model, created_at)
       VALUES ('Did the trial show benefits for stage IV patients?', 'global', NULL, 'pending', 'ask:v1', 'default', 1000)`,
    ).run();
    const questionId = Number(qRes.meta.last_row_id);

    // Tampered quote: stripped the word "no" to reverse meaning!
    const transport = makeFakeTransport((_model, _input) => {
      return {
        sufficient: true,
        neededUrls: [],
        answer: "The trial found benefits for patients.",
        unverified: [],
        citations: [
          {
            articleId: artId,
            quote:
              "The clinical trial demonstrated significant benefit in patients with stage IV illness.",
            claim: "Trial showed benefits",
          },
        ],
      };
    });

    const result = await answerQuestion(
      { ...env, MODEL_CALLS_ENABLED: "true" },
      questionId,
      1000,
      {
        bodies: r2 as unknown as R2Bucket,
        vectors: vectors as unknown as Pick<VectorizeIndex, "query">,
        transport,
      },
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      // Because the quote was tampered, verification failed -> 0 valid citations -> refusal!
      expect(result.refusal).toBe(true);
      expect(result.citationsCount).toBe(0);
    }

    const row = await env.DB.prepare(`SELECT * FROM questions WHERE id = ?1`)
      .bind(questionId)
      .first<{ refusal: number; unverified: string; citations: string }>();
    expect(row?.refusal).toBe(1);
    expect(row?.unverified).toContain("Unverified quote");
    expect(JSON.parse(row?.citations ?? "[]").length).toBe(0);
  });

  it("handles supplementary whitelist fetching when evidence is initially insufficient", async () => {
    await seedTestCorpus();

    const qRes = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status, prompt_version, model, created_at)
       VALUES ('What did arXiv paper https://arxiv.org/abs/2501.99999 discover about diffusion transformers?', 'global', NULL, 'pending', 'ask:v1', 'default', 1000)`,
    ).run();
    const questionId = Number(qRes.meta.last_row_id);

    let round = 1;
    const transport = makeFakeTransport((_model, _input) => {
      if (round === 1) {
        round = 2;
        return {
          sufficient: false,
          neededUrls: ["https://arxiv.org/abs/2501.99999"],
          answer: "Need primary paper text.",
          unverified: ["Diffusion transformer discovery"],
          citations: [],
        };
      }
      return {
        sufficient: true,
        neededUrls: [],
        answer:
          "Diffusion transformers scale quadratically with token resolution.",
        unverified: [],
        citations: [
          {
            articleId: 900001,
            quote:
              "Diffusion transformers exhibit quadratic scaling across high token resolution regimes.",
            claim: "Scales quadratically",
          },
        ],
      };
    });

    // Mock fetchPage via fetch
    const fetchedMarkdown =
      "# Diffusion Transformers Paper\n\nDiffusion transformers exhibit quadratic scaling across high token resolution regimes.\n\nIn our empirical testing, our extensive experimental evaluations across standard high-resolution image benchmarks demonstrate that computational complexity increases significantly when spatial token count grows beyond the baseline threshold, confirming key theoretical predictions.";
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      }
      return new Response(fetchedMarkdown, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    const result = await answerQuestion(
      { ...env, MODEL_CALLS_ENABLED: "true" },
      questionId,
      1000,
      {
        transport,
        fetch: mockFetch,
      },
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.refusal).toBe(false);
      expect(result.citationsCount).toBe(1);
    }

    const row = await env.DB.prepare(`SELECT * FROM questions WHERE id = ?1`)
      .bind(questionId)
      .first<{ supplemental_fetched: string; refusal: number }>();
    expect(row?.refusal).toBe(0);
    const supplemental = JSON.parse(row?.supplemental_fetched ?? "[]");
    expect(supplemental.length).toBe(1);
    expect(supplemental[0].status).toBe("ok");
    expect(supplemental[0].url).toContain("arxiv.org");
  });

  it("blocks supplementary fetch for non-whitelisted domains", async () => {
    await seedTestCorpus();

    const qRes = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status, prompt_version, model, created_at)
       VALUES ('What is the news on https://unknown-untrusted-site.com/post?', 'global', NULL, 'pending', 'ask:v1', 'default', 1000)`,
    ).run();
    const questionId = Number(qRes.meta.last_row_id);

    const transport = makeFakeTransport((_model, _input) => {
      return {
        sufficient: false,
        neededUrls: ["https://unknown-untrusted-site.com/post"],
        answer: "Cannot verify from trusted sources.",
        unverified: ["Untrusted site content"],
        citations: [],
      };
    });

    const result = await answerQuestion(
      { ...env, MODEL_CALLS_ENABLED: "true" },
      questionId,
      1000,
      { transport },
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.refusal).toBe(true);
    }

    const row = await env.DB.prepare(`SELECT * FROM questions WHERE id = ?1`)
      .bind(questionId)
      .first<{ supplemental_fetched: string; refusal: number }>();
    expect(row?.refusal).toBe(1);
    const supplemental = JSON.parse(row?.supplemental_fetched ?? "[]");
    expect(supplemental.length).toBe(1);
    expect(supplemental[0].status).toBe("blocked");
  });

  it("fails immediately without network calls when MODEL_CALLS_ENABLED is off", async () => {
    await seedTestCorpus();

    const qRes = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status, prompt_version, model, created_at)
       VALUES ('Will this run when disabled?', 'global', NULL, 'pending', 'ask:v1', 'default', 1000)`,
    ).run();
    const questionId = Number(qRes.meta.last_row_id);

    const result = await answerQuestion(
      { ...env, MODEL_CALLS_ENABLED: "false" },
      questionId,
      1000,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("MODEL_CALLS_ENABLED is off");
    }

    const row = await env.DB.prepare(`SELECT * FROM questions WHERE id = ?1`)
      .bind(questionId)
      .first<{ status: string; error_message: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toBe("MODEL_CALLS_ENABLED is off");
  });

  it("handles ask message in Q_GENERATE consumer", async () => {
    await seedTestCorpus();

    const qRes = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status, prompt_version, model, created_at)
       VALUES ('Consumer test question', 'global', NULL, 'pending', 'ask:v1', 'default', 1000)`,
    ).run();
    const questionId = Number(qRes.meta.last_row_id);

    let acked = false;
    const batch = {
      queue: "ainews-generate",
      messages: [
        {
          id: "msg_1",
          body: { kind: "ask", questionId } as GenerateMessage,
          timestamp: new Date(),
          ack: () => {
            acked = true;
          },
          retry: () => {},
        },
      ],
    };

    const transport = makeFakeTransport((_model, _input) => {
      return {
        sufficient: false,
        neededUrls: [],
        answer: "Refused due to no evidence in consumer test.",
        unverified: ["No facts"],
        citations: [],
      };
    });

    await handleGenerateBatch(
      batch as unknown as MessageBatch<GenerateMessage>,
      { ...env, MODEL_CALLS_ENABLED: "true" },
      { transport },
    );

    expect(acked).toBe(true);

    const row = await env.DB.prepare(
      `SELECT status FROM questions WHERE id = ?1`,
    )
      .bind(questionId)
      .first<{ status: string }>();
    expect(row?.status).toBe("completed");
  });

  it("fails and halts when single question budget cap is exceeded", async () => {
    await seedTestCorpus();

    const qRes = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status, prompt_version, model, created_at)
       VALUES ('Budget exceeding question', 'global', NULL, 'pending', 'ask:v1', 'default', 1000)`,
    ).run();
    const questionId = Number(qRes.meta.last_row_id);

    // Simulate pre-existing excessive llm_calls cost for this question
    await env.DB.prepare(
      `INSERT INTO llm_calls (logical_key, slot, model, channel, status, cost_micros, created_at, updated_at)
       VALUES (?1, 'reason', 'google/gemini-3.8-flash', 'gateway', 'completed', ?2, 1000, 1000)`,
    )
      .bind(
        `ask:reason:${questionId}:r1:fake`,
        ASK_QUESTION_MAX_COST_MICROS + 1000,
      )
      .run();

    const transport = makeFakeTransport((_model, _input) => {
      return {
        sufficient: false,
        neededUrls: [],
        answer: "Should fail on cost",
        unverified: [],
        citations: [],
      };
    });

    const result = await answerQuestion(
      { ...env, MODEL_CALLS_ENABLED: "true" },
      questionId,
      1000,
      { transport },
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("Question budget exceeded");
    }

    const row = await env.DB.prepare(
      `SELECT status, error_message FROM questions WHERE id = ?1`,
    )
      .bind(questionId)
      .first<{ status: string; error_message: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toBe("Question budget exceeded");
  });
});
