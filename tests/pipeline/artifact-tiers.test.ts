// Artifact generation under the gateway budget tiers (#116).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_TYPES } from "../../src/lib/artifacts/types";
import { generateEventArtifacts } from "../../src/pipeline/artifacts/build";
import { ARTIFACT_REGISTRY } from "../../src/pipeline/artifacts/registry";
import { enqueueDueEvents } from "../../src/pipeline/due-events";
import { handleGenerateBatch } from "../../src/pipeline/generate/consumer";
import type { GenerateMessage, PipelineEnv } from "../../src/pipeline/messages";
import { utcDay } from "../../src/providers/budget";
import { BudgetExceededError } from "../../src/providers/models";
import { ARTIFACT_TIERS } from "../../src/providers/tiers";
import type { ModelTransport } from "../../src/providers/transport";

const testEnv: PipelineEnv = { ...env, MODEL_CALLS_ENABLED: "true" };

const CONFIG = JSON.stringify({
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
  artifacts: { deepThreshold: 60 },
});

class FakeQueue {
  sent: GenerateMessage[] = [];
  async send(msg: GenerateMessage) {
    this.sent.push(msg);
  }
  async sendBatch(msgs: Iterable<{ body: GenerateMessage }>) {
    this.sent.push(...Array.from(msgs).map((m) => m.body));
  }
}

/** Valid Story Brief and Explain output; every other type gets the Explain. */
function transport(): ModelTransport & { calls: number } {
  const t = {
    calls: 0,
    run: async (_model: string, input: unknown) => {
      t.calls += 1;
      const brief = JSON.stringify(input).includes("Story Brief");
      const body = brief
        ? {
            whatHappened: "Researchers proved attention bounds.",
            whatIsNew: "A tight bound.",
            whatEvidenceExists: "Theorem 1.",
            whatToWatchNext: "Kernels.",
          }
        : {
            audience: "student",
            overview: "A faster attention method.",
            keyPoints: ["Attention is faster"],
            implications: ["Longer documents"],
            glossary: [{ term: "Attention", definition: "Focus." }],
          };
      return {
        candidates: [
          {
            content: { role: "model", parts: [{ text: JSON.stringify(body) }] },
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
  return t;
}

/** A deep arXiv event: Story Brief, Explain (tier 2), then tier 4 products. */
async function seedDeepEvent(tag: string): Promise<number> {
  const ind = await env.DB.prepare(
    "INSERT INTO industries (slug, name, publish_mode, config, created_at) VALUES (?1, ?1, 'auto', ?2, 1000) RETURNING id",
  )
    .bind(`tiers-${tag}`, CONFIG)
    .first<{ id: number }>();
  const src = await env.DB.prepare(
    "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, ?2, 'arxiv.org', 'rss', 1000) RETURNING id",
  )
    .bind(ind!.id, `https://arxiv.org/${tag}/feed`)
    .first<{ id: number }>();
  const url = `https://arxiv.org/abs/${tag}`;
  const art = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
     VALUES (?1, ?2, ?3, ?3, 'Sparse Attention Bounds', 'Paper abstract', ?4, 1000, 'grouped', 1000)
     RETURNING id`,
  )
    .bind(src!.id, ind!.id, url, `sha-${tag}`)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, ?2, 'approved', 'auto', 1000)",
  )
    .bind(art!.id, `sha-${tag}`)
    .run();
  await env.DB.prepare(
    `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_relevant, prefilter_pass, category, noise_kind, selected, created_at)
     VALUES (?1, 'pv1', '{}', 'research_paper', '{"publication_status":"preprint"}', 88, 0.95, 1, 'cat', 'none', 1, 1000)`,
  )
    .bind(art!.id)
    .run();
  const event = await env.DB.prepare(
    "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Tier Event', 1, 1000, 1000) RETURNING id",
  )
    .bind(ind!.id)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
  )
    .bind(event!.id, art!.id)
    .run();
  return event!.id;
}

async function setBudget(day: string, cap: number, spent: number) {
  await env.DB.prepare(
    `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
     VALUES (?1, 'gateway', ?2, 0, ?3)
     ON CONFLICT (day, channel) DO UPDATE SET cap_micros = ?2,
       reserved_micros = 0, spent_micros = ?3`,
  )
    .bind(day, cap, spent)
    .run();
}

async function evaluatedRevision(eventId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT artifacts_evaluated_revision AS r FROM events WHERE id = ?1",
  )
    .bind(eventId)
    .first<{ r: number }>();
  return row!.r;
}

afterEach(async () => {
  await env.DB.prepare(
    "DELETE FROM settings WHERE key = 'budget.tier_reserves'",
  ).run();
});

describe("artifact tiers", () => {
  it("ARTIFACT_TIERS covers every model-generated type; the registry runs tier 2 first", () => {
    const generated = ARTIFACT_TYPES.filter((t) => t !== "revision_diff");
    expect(Object.keys(ARTIFACT_TIERS).sort()).toEqual([...generated].sort());

    const order = Object.values(ARTIFACT_REGISTRY).map(
      (def) => ARTIFACT_TIERS[def.type as keyof typeof ARTIFACT_TIERS],
    );
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    }

    for (const [type, tier] of Object.entries(ARTIFACT_TIERS)) {
      const expected =
        type === "story_brief" || type === "audience_explain" ? 2 : 4;
      expect([type, tier]).toEqual([type, expected]);
    }
  });

  it("tier 4 is refused while tier 2 still passes: Story Brief is written, the revision stays due", async () => {
    // floor(2) = 100,000 and floor(4) = 300,000 on a 1,000,000 cap.
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('budget.tier_reserves', '{"1":100000,"2":100000,"3":100000,"4":0}', 0)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run();
    const commitNow = Date.UTC(2030, 0, 1, 12, 0, 0);
    await setBudget("2030-01-01", 1_000_000, 850_000);
    const id = await seedDeepEvent("r10");

    const error = await generateEventArtifacts(testEnv, id, commitNow, {
      transport: transport(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as { tier?: number }).tier).toBe(4);

    const { results: made } = await env.DB.prepare(
      "SELECT DISTINCT type FROM event_artifacts WHERE event_id = ?1 ORDER BY type",
    )
      .bind(id)
      .all<{ type: string }>();
    expect(made.map((r) => r.type)).toEqual([
      "audience_explain",
      "story_brief",
    ]);
    expect(await evaluatedRevision(id)).toBe(0);

    const { results: rows } = await env.DB.prepare(
      `SELECT logical_key, status, error, tier FROM llm_calls
       WHERE logical_key LIKE ?1 ORDER BY id`,
    )
      .bind(`artifact:${id}:%`)
      .all<{
        logical_key: string;
        status: string;
        error: string | null;
        tier: number;
      }>();
    // `artifact:{eventId}:{type}:…` -> `artifact:{eventId}:{type}`.
    const calls = rows.map(({ logical_key, ...rest }) => ({
      head: logical_key.split(":").slice(0, 3).join(":"),
      ...rest,
    }));
    const brief = calls.filter((c) => c.head.endsWith(":story_brief"));
    expect(brief).toEqual([
      {
        head: `artifact:${id}:story_brief`,
        status: "completed",
        error: null,
        tier: 2,
      },
    ]);
    const tier4 = calls.filter(
      (c) =>
        !c.head.endsWith(":story_brief") &&
        !c.head.endsWith(":audience_explain"),
    );
    expect(tier4).toEqual([
      {
        head: `artifact:${id}:research_paper_decoder`,
        status: "failed",
        error: "budget_exceeded",
        tier: 4,
      },
    ]);
  });

  it("handleGenerateBatch acks an artifacts message refused by the budget; the event stays due", async () => {
    const today = utcDay(Date.now());
    await setBudget(today, 1_900_000, 1_900_000);
    try {
      const id = await seedDeepEvent("r8");
      const t = transport();
      let acked = 0;
      let retried = 0;
      const msg: Message<GenerateMessage> = {
        id: "msg-r8",
        timestamp: new Date(),
        body: { kind: "artifacts", eventId: id },
        attempts: 1,
        ack: () => {
          acked += 1;
        },
        retry: () => {
          retried += 1;
        },
      };
      const batch: MessageBatch<GenerateMessage> = {
        queue: "ainews-generate",
        messages: [msg],
        metadata: {} as unknown as MessageBatchMetadata,
        ackAll: () => {},
        retryAll: () => {},
      };

      await handleGenerateBatch(batch, testEnv, { transport: t });

      expect({ acked, retried }).toEqual({ acked: 1, retried: 0 });
      expect(t.calls).toBe(0);
      expect(await evaluatedRevision(id)).toBe(0);
      const queue = new FakeQueue();
      const due = await enqueueDueEvents(
        { DB: env.DB, Q_GENERATE: queue as unknown as Queue },
        "artifacts",
        Date.now(),
        1000,
      );
      expect(due).toContain(id);
    } finally {
      await env.DB.prepare(
        "DELETE FROM budgets WHERE day = ?1 AND channel = 'gateway'",
      )
        .bind(today)
        .run();
    }
  });
});
