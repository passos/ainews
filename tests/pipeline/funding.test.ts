import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  convertToMicroUsd,
  convertToMicroUsdExact,
  mergeNames,
  normalizeCompanyKey,
  normalizeRoundKey,
  normalizeSector,
  stageForRoundKey,
} from "../../src/lib/funding/normalize";
import {
  extractFundingRounds,
  type FundingDeps,
  fundingCompletionKey,
  applyFundingObservation,
} from "../../src/pipeline/funding/extract";
import { getDb } from "../../src/server/db/client";
import {
  getFundingRoundDetails,
  getPublishedFundingRounds,
} from "../../src/server/publication/funding";
import {
  captureFundingObservation,
  decideFundingObservation,
} from "../../src/pipeline/funding/observations";
import {
  extractedRoundSchema,
  type ConfirmedFundingIdentity,
  type ExtractedRound,
} from "../../src/lib/funding/types";
import { decideFundingRound } from "../../src/server/admin/ops";
import { FUNDING_PROMPT_VERSION } from "../../src/pipeline/funding/prompts";
import { enqueueDueFunding } from "../../src/pipeline/funding/schedule";
import { handleGenerateBatch } from "../../src/pipeline/generate/consumer";
import type { GenerateMessage, PipelineEnv } from "../../src/pipeline/messages";
import type { ModelTransport } from "../../src/providers/transport";
import { NOW, resetPipeline, seedIndustry, seedSource } from "./helpers";

const ON = { MODEL_CALLS_ENABLED: "true" } as const;

function pEnv(flags: Record<string, string> = ON): PipelineEnv {
  return {
    DB: env.DB,
    BODIES: env.BODIES,
    Q_INGEST: undefined as never,
    ...flags,
  } as unknown as PipelineEnv;
}

interface RoundOut {
  isFundingAnnouncement?: boolean;
  companyName: string;
  roundName: string;
  amount?: number | null;
  currency?: string | null;
  valuation?: number | null;
  sector?: string | null;
  investors?: string[];
  leadInvestors?: string[];
  announcedDate?: string | null;
  isCorrectionOrUpdate?: boolean;
  correctionReason?: string | null;
}

const FUNDING_BODY =
  "Funding announcement 2026-10-19 https://acme.example Acme AI Series A Seed.";
function v2Envelope(input: { rounds: RoundOut[] }, quote = FUNDING_BODY) {
  const evidenced = <T>(value: T) => ({ value, evidence: { quote } });
  return {
    version: 2,
    rounds: input.rounds
      .filter((round) => round.isFundingAnnouncement !== false)
      .map((round) => ({
        identity: {
          companyName: evidenced(round.companyName),
          roundName: evidenced(round.roundName),
          companyHost: evidenced(
            `https://${normalizeCompanyKey(round.companyName)}.example`,
          ),
          announcedDate:
            round.announcedDate === null
              ? null
              : evidenced(round.announcedDate ?? "2026-10-19"),
          sameEventEvidence: null,
        },
        reportedFacts: Object.fromEntries(
          [
            "amount",
            "currency",
            "valuation",
            "sector",
            "investors",
            "leadInvestors",
          ]
            .filter(
              (key) =>
                key in round &&
                (key !== "currency" || round.currency !== null) &&
                (key !== "sector" ||
                  ["fintech", "ai_infrastructure", "robotics"].includes(
                    round.sector ?? "",
                  )),
            )
            .map((key) => [key, evidenced(round[key as keyof RoundOut])]),
        ),
        correctionPatch:
          round.amount !== null && round.amount !== undefined && round.currency
            ? {
                amount: { op: "set", value: round.amount, evidence: { quote } },
                currency: {
                  op: "set",
                  value: round.currency,
                  evidence: { quote },
                },
              }
            : {},
        correctionReason: round.correctionReason ?? null,
      })),
  };
}
/** Synthetic transport response uses the actual supplied body quote; new v2 cases exercise ordinary facts separately. */
function fakeModels(rounds: RoundOut[] | string) {
  const calls: string[] = [];
  const models: FundingDeps["models"] = {
    async generateText(_slot, key, request) {
      calls.push(key);
      const material = JSON.parse(
        request.prompt.slice(request.prompt.indexOf("{")),
      );
      return {
        text:
          typeof rounds === "string"
            ? rounds
            : JSON.stringify(v2Envelope({ rounds }, material.body)),
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "STOP",
      };
    },
  };
  return { models, calls };
}

/** Pause after a real empty read, then run other workers before returning that read. */
function interleaveAfterEmptyRead(
  run: () => Promise<void>,
  activeRead = false,
): D1Database {
  let pending = true;
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, property) {
        if (property === "bind")
          return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === "first")
          return async (...args: unknown[]) => {
            const row = await Reflect.apply(target.first, target, args);
            if (pending && (activeRead ? row === null : row !== null)) {
              pending = false;
              await run();
            }
            return row;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    prepare(query: string) {
      const stmt = env.DB.prepare(query);
      return query.startsWith(
        activeRead
          ? "SELECT * FROM funding_rounds"
          : "SELECT canonical_url,title FROM articles",
      )
        ? wrap(stmt)
        : stmt;
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

let financeId = 0;
let sourceId = 0;
let seq = 0;

async function seedArticle(opts?: {
  approved?: boolean;
  industryId?: number;
  fundingType?: boolean;
  body?: string;
}): Promise<number> {
  seq += 1;
  const sha = `sha${String(seq).padStart(20, "0")}`;
  const row = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title,
       fetched_at, stage, stage_updated_at, body_sha, published_at)
     VALUES (?1, ?2, ?3, ?3, ?4, 0, 'analyzed', 0, ?5, ?6) RETURNING id`,
  )
    .bind(
      sourceId,
      opts?.industryId ?? financeId,
      `https://news.example/funding-${seq}`,
      `Acme raises money #${seq}`,
      sha,
      Date.parse("2026-10-20T00:00:00Z"),
    )
    .first<{ id: number }>();
  const id = row!.id;
  await env.BODIES.put(`bodies/${id}/${sha}.md`, opts?.body ?? FUNDING_BODY);
  if (opts?.approved !== false) {
    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, ?2, 'approved', 'test', 0)`,
    )
      .bind(id, sha)
      .run();
  }
  if (opts?.fundingType !== false) {
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type,
         evidence_tags, total_score, created_at)
       VALUES (?1, 'v', '{}', 'funding_round', '{}', 80, 0)`,
    )
      .bind(id)
      .run();
  }
  return id;
}

interface ActiveRow {
  id: number;
  status: string;
  amount: number | null;
  currency: string;
  amount_micros: number | null;
  investors: string;
  source_articles: string;
  superseded_by: number | null;
  correction_reason: string | null;
  announced_date: string | null;
  stage: string;
  round_key: string;
  company_key: string;
}

async function allRounds(): Promise<ActiveRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM funding_rounds ORDER BY id",
  ).all<ActiveRow>();
  return results;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM funding_observations"),
    env.DB.prepare("DELETE FROM corrections"),
    env.DB.prepare("DELETE FROM funding_rounds"),
    env.DB.prepare("DELETE FROM llm_calls"),
    env.DB.prepare("DELETE FROM settings WHERE key LIKE 'funding:done:%'"),
  ]);
  await resetPipeline();
  financeId = await seedIndustry("finance");
  sourceId = await seedSource({
    industryId: financeId,
    feedUrl: "https://news.example/feed",
  });
});

function protocolRound(quote = FUNDING_BODY): ExtractedRound {
  const batch = v2Envelope(
    {
      rounds: [
        { companyName: "Acme", roundName: "Seed", amount: 10, currency: "USD" },
      ],
    },
    quote,
  );
  const round = extractedRoundSchema.parse(batch.rounds[0]);
  round.correctionPatch = {};
  return round;
}
const protocolModels = (rounds: ExtractedRound[]): FundingDeps["models"] => ({
  generateText: async () => ({
    text: JSON.stringify({ version: 2, rounds }),
    finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
});
const manualTarget: ConfirmedFundingIdentity = {
  companyKey: "manual:acme",
  roundKey: "manual:seed",
  companyName: "Acme",
  roundName: "Seed",
  companyHost: null,
  announcedDate: null,
  concreteRound: "seed",
  source: "manual",
};
async function observations() {
  return (
    await env.DB.prepare(
      "SELECT * FROM funding_observations ORDER BY article_id,item_index",
    ).all<
      import("../../src/pipeline/funding/observations").FundingObservation
    >()
  ).results;
}

describe("funding v2 observations", () => {
  it.each([false, true])(
    "ten date-missing observations become one round after manual association (missing host=%s)",
    async (missingHost) => {
      for (let i = 0; i < 10; i++) {
        const id = await seedArticle();
        const round = protocolRound();
        if (missingHost) round.identity.companyHost = null;
        round.identity.announcedDate = null;
        await extractFundingRounds(pEnv(), id, NOW, {
          models: protocolModels([round]),
        });
      }
      expect(await allRounds()).toEqual([]);
      const rows = await observations();
      expect(rows.every((row) => row.state === "unresolved")).toBe(true);
      const reviews = (
        await env.DB.prepare("SELECT * FROM reviews ORDER BY article_id").all()
      ).results;
      for (const row of rows) {
        expect(
          await decideFundingObservation(
            env.DB,
            row.id,
            0,
            manualTarget,
            "Confirmed same round; date not disclosed",
            NOW,
          ),
        ).toBe(true);
        await applyFundingObservation(env.DB, env.BODIES, row.id, 1, NOW);
      }
      expect(await allRounds()).toHaveLength(1);
      expect((await allRounds())[0].announced_date).toBeNull();
      expect(JSON.parse((await allRounds())[0].source_articles)).toHaveLength(
        10,
      );
      expect(
        (
          await env.DB.prepare(
            "SELECT * FROM reviews ORDER BY article_id",
          ).all()
        ).results,
      ).toEqual(reviews);
      expect(
        await decideFundingObservation(
          env.DB,
          rows[0].id,
          0,
          manualTarget,
          "Duplicate decision",
          NOW,
        ),
      ).toBe(false);
      expect(
        await applyFundingObservation(env.DB, env.BODIES, rows[0].id, 0, NOW),
      ).toBe("ignored");
      expect(
        await applyFundingObservation(env.DB, env.BODIES, rows[0].id, 1, NOW),
      ).toBe("ignored");
    },
  );

  it("keeps distinct announcement dates separate and keys a company by name with or without a host", async () => {
    for (const [host, date] of [
      ["https://acme.example", "2026-10-19"],
      ["https://acme.example", "2026-10-20"],
      [null, "2026-10-19"],
    ] as const) {
      const quote = `Acme Seed 10 USD announced ${date}${host ? ` by ${host}` : ""}`;
      const id = await seedArticle({ body: quote });
      const round = protocolRound(quote);
      if (host) round.identity.companyHost!.value = host;
      else round.identity.companyHost = null;
      round.identity.announcedDate!.value = date;
      await extractFundingRounds(pEnv(), id, NOW, {
        models: protocolModels([round]),
      });
    }
    const rows = await allRounds();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.company_key))).toEqual(
      new Set(["entity:acme"]),
    );
    expect((await observations()).every((row) => row.state === "applied")).toBe(
      true,
    );
    expect(
      JSON.parse(
        rows.find((row) => row.announced_date === "2026-10-19")!
          .source_articles,
      ),
    ).toHaveLength(2);
  });

  it("applies evidenced valuation/date/list corrections to a pending version of the same stable event", async () => {
    const quote =
      "Acme Seed on 2026-10-19; corrected valuation 80, announcement 2026-10-18, Alpha removed and Gamma leads; same financing.";
    const first = await seedArticle({ body: quote });
    const base = protocolRound(quote);
    base.reportedFacts.valuation = { value: 100, evidence: { quote } };
    base.reportedFacts.investors = {
      value: ["Alpha", "Beta"],
      evidence: { quote },
    };
    base.reportedFacts.leadInvestors = {
      value: ["Alpha"],
      evidence: { quote },
    };
    await extractFundingRounds(pEnv(), first, NOW, {
      models: protocolModels([base]),
    });
    const old = (await allRounds())[0];
    await decideFundingRound(env.DB, old.id, "published");
    const second = await seedArticle({ body: quote });
    const next = protocolRound(quote);
    next.identity.sameEventEvidence = { quote };
    next.correctionReason = "Company corrected the financing details";
    next.correctionPatch = {
      valuation: { op: "set", value: 80, evidence: { quote } },
      announcedDate: { op: "set", value: "2026-10-18", evidence: { quote } },
      investors: { op: "replace", values: [], evidence: { quote } },
      leadInvestors: {
        op: "delta",
        add: ["Gamma"],
        remove: ["Alpha"],
        evidence: { quote },
      },
    };
    await extractFundingRounds(pEnv(), second, NOW, {
      models: protocolModels([next]),
    });
    const rows = await allRounds();
    expect(rows).toHaveLength(2);
    expect(rows[1].round_key).toBe(old.round_key);
    expect(rows[1]).toMatchObject({
      status: "pending_review",
      announced_date: "2026-10-18",
      investors: "[]",
    });
    expect(
      await env.DB.prepare(
        "SELECT valuation,lead_investors FROM funding_rounds WHERE id=?1",
      )
        .bind(rows[1].id)
        .first(),
    ).toEqual({ valuation: 80, lead_investors: '["Gamma"]' });
    expect(
      await env.DB.prepare(
        "SELECT valuation,announced_date FROM funding_rounds WHERE id=?1",
      )
        .bind(old.id)
        .first(),
    ).toEqual({ valuation: 100, announced_date: "2026-10-19" });
  });

  it.each([1, 10])(
    "fully captures and applies %i complete v2 rounds",
    async (count) => {
      const quote = Array.from(
        { length: count },
        (_, i) =>
          `Company ${i} https://company${i}.example Seed 2026-10-19 raised 10 USD, corrected to 12; Alpha joins`,
      ).join("; ");
      const rounds = Array.from({ length: count }, (_, i) => {
        const round = protocolRound(quote);
        round.identity.companyName.value = `Company ${i}`;
        round.identity.companyHost!.value = `https://company${i}.example`;
        round.correctionPatch = {
          amount: { op: "set", value: 12, evidence: { quote } },
          investors: {
            op: "delta",
            add: ["Alpha"],
            remove: [],
            evidence: { quote },
          },
        };
        return round;
      });
      const id = await seedArticle({ body: quote });
      await extractFundingRounds(pEnv(), id, NOW, {
        models: protocolModels(rounds),
      });
      expect(await allRounds()).toHaveLength(count);
      expect((await allRounds()).every((row) => row.amount === 12)).toBe(true);
      expect(
        (await observations()).filter((row) => row.state === "applied"),
      ).toHaveLength(count);
    },
  );

  it("processes an excerpt without changing the complete R2 body or its version", async () => {
    const body = FUNDING_BODY + "\n" + "x".repeat(18000);
    const id = await seedArticle({ body });
    const before = await env.DB.prepare(
      "SELECT body_sha FROM articles WHERE id=?1",
    )
      .bind(id)
      .first<{ body_sha: string }>();
    await extractFundingRounds(pEnv(), id, NOW, {
      models: {
        generateText: async (_slot, _key, request) => {
          const material = JSON.parse(
            request.prompt.slice(request.prompt.indexOf("{")),
          );
          expect(material.body).toBe(body.slice(0, 12000));
          expect(material.bodyIsExcerpt).toBe(true);
          expect(request.maxOutputTokens).toBe(8000);
          return {
            text: JSON.stringify({ version: 2, rounds: [protocolRound()] }),
            finishReason: "STOP",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
    expect(
      await env.DB.prepare("SELECT body_sha FROM articles WHERE id=?1")
        .bind(id)
        .first(),
    ).toEqual(before);
    expect(
      await (await env.BODIES.get(
        `bodies/${id}/${before!.body_sha}.md`,
      ))!.text(),
    ).toBe(body);
  });

  it.each(["eleven", "round_limit", "MAX_TOKENS", "SAFETY", "invalid_quote"])(
    "rejects %s without partial business writes",
    async (kind) => {
      const id = await seedArticle();
      const round = protocolRound();
      if (kind === "invalid_quote")
        round.identity.companyName.evidence.quote = "not in this body";
      const text = JSON.stringify(
        kind === "round_limit"
          ? { error: "round_limit" }
          : {
              version: 2,
              rounds: Array.from(
                { length: kind === "eleven" ? 11 : 1 },
                () => round,
              ),
            },
      );
      await expect(
        extractFundingRounds(pEnv(), id, NOW, {
          models: {
            generateText: async () => ({
              text,
              finishReason: ["MAX_TOKENS", "SAFETY"].includes(kind)
                ? kind
                : "STOP",
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
          },
        }),
      ).rejects.toThrow();
      expect(await allRounds()).toEqual([]);
      expect(await observations()).toEqual([]);
      expect(
        (await env.DB.prepare(
          "SELECT count(*) n FROM settings WHERE key LIKE 'funding:done:%'",
        ).first<{ n: number }>())!.n,
      ).toBe(0);
    },
  );

  it.each(["capture", "application", "receipt", "marker"])(
    "reuses the completed ledger response after a %s failure",
    async (point) => {
      const id = await seedArticle();
      let calls = 0;
      const transport: ModelTransport = {
        run: async () => {
          calls++;
          return {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      text: JSON.stringify({
                        version: 2,
                        rounds: [protocolRound()],
                      }),
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          };
        },
      };
      const trigger =
        point === "capture"
          ? "BEFORE INSERT ON funding_observations"
          : point === "application"
            ? "BEFORE INSERT ON funding_rounds"
            : point === "receipt"
              ? "BEFORE UPDATE ON funding_observations WHEN NEW.state='applied'"
              : "BEFORE INSERT ON settings WHEN NEW.key LIKE 'funding:done:%'";
      await env.DB.prepare(
        `CREATE TRIGGER fail_observation ${trigger} BEGIN SELECT RAISE(ABORT,'injected ${point}'); END`,
      ).run();
      try {
        await expect(
          extractFundingRounds(pEnv(), id, NOW, { transport }),
        ).rejects.toThrow(/injected/);
      } finally {
        await env.DB.prepare("DROP TRIGGER fail_observation").run();
      }
      if (point === "receipt") expect(await allRounds()).toEqual([]);
      await extractFundingRounds(pEnv(), id, NOW + 1, { transport });
      expect(calls).toBe(1);
      expect(await allRounds()).toHaveLength(1);
      const rows = await observations();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "applied", decision_revision: 1 });
      expect(JSON.parse((await allRounds())[0].source_articles)).toHaveLength(
        1,
      );
    },
  );

  it.each([false, true])(
    "keeps capture immutable and blocks a stale decision (same target=%s)",
    async (sameTarget) => {
      const id = await seedArticle();
      const round = protocolRound();
      round.identity.announcedDate = null;
      await extractFundingRounds(pEnv(), id, NOW, {
        models: protocolModels([round]),
      });
      const captured = (await observations())[0];
      await decideFundingObservation(
        env.DB,
        captured.id,
        0,
        manualTarget,
        "Confirmed unknown date",
        NOW,
      );
      const changed = protocolRound();
      changed.reportedFacts.amount!.value = 999;
      const retry = await captureFundingObservation(
        env.DB,
        id,
        captured.body_sha,
        FUNDING_PROMPT_VERSION,
        0,
        changed,
        FUNDING_BODY,
        NOW,
      );
      expect(retry.payload_json).toBe(captured.payload_json);
      expect(retry.decision_revision).toBe(1);
      const other = sameTarget
        ? manualTarget
        : {
            ...manualTarget,
            companyKey: "manual:other",
            roundKey: "manual:other-event",
          };
      const db = interleaveAfterEmptyRead(async () => {
        await decideFundingObservation(
          env.DB,
          captured.id,
          1,
          other,
          "Explicit different entity",
          NOW,
        );
      });
      expect(
        await applyFundingObservation(db, env.BODIES, captured.id, 1, NOW),
      ).toBe("ignored");
      expect(await allRounds()).toEqual([]);
      await applyFundingObservation(env.DB, env.BODIES, captured.id, 2, NOW);
      expect((await allRounds())[0].company_key).toBe(other.companyKey);
      expect(
        await applyFundingObservation(env.DB, env.BODIES, captured.id, 1, NOW),
      ).toBe("ignored");
    },
  );

  it("does not pay to reanalyze a legacy completed body but allows a different body", async () => {
    const id = await seedArticle();
    const article = await env.DB.prepare(
      "SELECT body_sha FROM articles WHERE id=?1",
    )
      .bind(id)
      .first<{ body_sha: string }>();
    await env.DB.prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES (?1,'true',0)",
    )
      .bind(`funding:done:${id}:funding-v1:${article!.body_sha}`)
      .run();
    const models = fakeModels([{ companyName: "Acme", roundName: "Seed" }]);
    expect(
      await extractFundingRounds(pEnv(), id, NOW, { models: models.models }),
    ).toMatchObject({ status: "skipped", reason: "already_completed" });
    expect(models.calls).toEqual([]);
    const sent: GenerateMessage[] = [];
    const queue = {
      ...pEnv(),
      Q_GENERATE: {
        sendBatch: async (items: { body: GenerateMessage }[]) => {
          sent.push(...items.map((item) => item.body));
        },
      },
    } as unknown as PipelineEnv;
    expect(await enqueueDueFunding(queue, NOW)).toEqual([]);
    await env.DB.prepare("UPDATE articles SET body_sha='v2-new' WHERE id=?1")
      .bind(id)
      .run();
    await env.DB.prepare(
      "INSERT INTO reviews(article_id,body_sha,decision,reviewer,created_at) VALUES (?1,'v2-new','approved','test',0)",
    )
      .bind(id)
      .run();
    await env.BODIES.put(`bodies/${id}/v2-new.md`, FUNDING_BODY);
    expect(await enqueueDueFunding(queue, NOW)).toEqual([id]);
    await extractFundingRounds(pEnv(), id, NOW, {
      models: protocolModels([protocolRound()]),
    });
    expect(await allRounds()).toHaveLength(1);
  });

  it("a stale page cannot reassign an applied observation", async () => {
    const id = await seedArticle();
    const round = protocolRound();
    round.identity.announcedDate = null;
    await extractFundingRounds(pEnv(), id, NOW, {
      models: protocolModels([round]),
    });
    const [captured] = await observations();
    expect(
      await decideFundingObservation(
        env.DB,
        captured.id,
        0,
        manualTarget,
        "Confirmed unknown date",
        NOW,
      ),
    ).toBe(true);
    expect(
      await applyFundingObservation(env.DB, env.BODIES, captured.id, 1, NOW),
    ).toBe("inserted");
    const before = await allRounds();
    const other = {
      ...manualTarget,
      companyKey: "manual:other",
      roundKey: "manual:other-event",
    };
    expect(
      await decideFundingObservation(
        env.DB,
        captured.id,
        1,
        other,
        "Stale page decision",
        NOW,
      ),
    ).toBe(false);
    expect(
      await applyFundingObservation(env.DB, env.BODIES, captured.id, 2, NOW),
    ).toBe("ignored");
    expect(await allRounds()).toEqual(before);
    expect((await observations())[0]).toMatchObject({
      state: "applied",
      decision_revision: 1,
    });
  });

  it("keeps one source per article when its body version changes, and stays public", async () => {
    const id = await seedArticle();
    const { models } = fakeModels([
      { companyName: "Acme", roundName: "Seed", amount: 10, currency: "USD" },
    ]);
    await extractFundingRounds(pEnv(), id, NOW, { models });
    const [round] = await allRounds();
    expect(await decideFundingRound(env.DB, round.id, "published")).toBe(true);
    await env.DB.prepare("UPDATE articles SET body_sha='new-body' WHERE id=?1")
      .bind(id)
      .run();
    await env.DB.prepare(
      "INSERT INTO reviews(article_id,body_sha,decision,reviewer,created_at) VALUES (?1,'new-body','approved','test',0)",
    )
      .bind(id)
      .run();
    await env.BODIES.put(`bodies/${id}/new-body.md`, FUNDING_BODY);
    await extractFundingRounds(pEnv(), id, NOW + 1, { models });
    const active = (await allRounds()).filter((r) => r.superseded_by === null);
    expect(active).toHaveLength(1);
    const sources = JSON.parse(active[0].source_articles);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ articleId: id, bodySha: "new-body" });
    expect(
      (await getPublishedFundingRounds(getDb(env.DB))).items.map((r) => r.id),
    ).toEqual([active[0].id]);
  });

  it("a new record has no correction reason", async () => {
    const id = await seedArticle();
    const round = protocolRound();
    round.correctionReason = null;
    await extractFundingRounds(pEnv(), id, NOW, {
      models: protocolModels([round]),
    });
    const rows = await allRounds();
    expect(rows).toHaveLength(1);
    expect(rows[0].correction_reason).toBeNull();
  });
});

describe("funding normalisation", () => {
  it("converts large and FX amounts with exact integer micro factors", () => {
    expect(convertToMicroUsdExact(13_000_000_000, "USD")).toBe(
      13_000_000_000_000_000n,
    );
    expect(convertToMicroUsdExact(8_000_000_001, "EUR")).toBe(
      8_640_000_001_080_000n,
    );
    expect(convertToMicroUsdExact(900_000_000_001, "JPY")).toBe(
      6_030_000_000_006_700n,
    );
    expect(convertToMicroUsd(8_000_000_001, "EUR")).toBe(8_640_000_001_080_000);
  });

  it("gives one company key to every spelling of the name", () => {
    expect(normalizeCompanyKey("Acme AI, Inc.")).toBe("acme-ai");
    expect(normalizeCompanyKey("ACME AI")).toBe("acme-ai");
    expect(normalizeCompanyKey("  Acme   A.I. Corp ")).toBe("acme-a-i");
    expect(normalizeCompanyKey("Café Société GmbH")).toBe("cafe-societe");
  });

  it("normalises round names and keeps series letters apart", () => {
    expect(normalizeRoundKey("Series A")).toBe("series_a");
    expect(normalizeRoundKey("series-b round")).toBe("series_b");
    expect(normalizeRoundKey("Pre-Seed")).toBe("pre_seed");
    expect(normalizeRoundKey("Seed extension")).toBe("seed");
    expect(normalizeRoundKey("Series D")).toBe("series_d");
    expect(normalizeRoundKey("Series E")).toBe("series_e");
    expect(normalizeRoundKey("venture debt facility")).toBe("debt");
    expect(normalizeRoundKey("a mystery round")).toBe("undisclosed");
    expect(stageForRoundKey("series_d")).toBe("series_d_plus");
    expect(stageForRoundKey("series_e")).toBe("series_d_plus");
    expect(stageForRoundKey("series_b")).toBe("series_b");
    expect(stageForRoundKey("nonsense")).toBe("undisclosed");
  });

  it("maps unknown sectors to other", () => {
    expect(normalizeSector("AI Infrastructure")).toBe("ai_infrastructure");
    expect(normalizeSector("space tourism")).toBe("other");
    expect(normalizeSector(null)).toBe("other");
  });

  it("converts to integer micro-USD and refuses unsafe or unknown values", () => {
    expect(convertToMicroUsd(12_000_000, "USD")).toBe(12_000_000_000_000);
    expect(convertToMicroUsd(10, "eur")).toBe(10_800_000);
    expect(convertToMicroUsd(100, "XYZ")).toBeNull();
    expect(convertToMicroUsd(20_000_000_000, "USD")).toBeNull();
  });

  it("merges investor names without duplicates, sorted", () => {
    expect(
      mergeNames(["b Capital", "A Ventures"], ["B CAPITAL", "c Fund"]),
    ).toEqual(["A Ventures", "b Capital", "c Fund"]);
  });
});

describe("extractFundingRounds", () => {
  it("automatic pending revisions do not expose private prior amounts in public reasons", async () => {
    for (const amount of [10, 12, 11]) {
      const id = await seedArticle();
      await extractFundingRounds(pEnv(), id, NOW, {
        models: fakeModels([
          { companyName: "Acme", roundName: "Seed", amount, currency: "USD" },
        ]).models,
      });
      if (amount !== 12)
        await decideFundingRound(
          env.DB,
          (await allRounds()).at(-1)!.id,
          "published",
        );
    }
    const active = (await allRounds()).find((r) => r.superseded_by === null)!;
    const db = getDb(env.DB);
    const details = await getFundingRoundDetails(db, active.id);
    expect(details!.corrections[0].body).toMatch(/10 USD to 11 USD/);
    expect(JSON.stringify(details!.corrections)).not.toMatch(/12 USD/);
    expect(
      JSON.stringify(
        (await getPublishedFundingRounds(db)).items[0].corrections,
      ),
    ).not.toMatch(/12 USD/);
  });

  it.each([false, true])(
    "stale replay cannot supersede a newer result (empty active read=%s)",
    async (activeRead) => {
      const a = await seedArticle(),
        b = await seedArticle();
      const model = (amount: number) =>
        fakeModels([
          { companyName: "Acme", roundName: "Seed", amount, currency: "USD" },
        ]).models;
      const db = interleaveAfterEmptyRead(async () => {
        await extractFundingRounds(pEnv(), a, NOW, { models: model(10) });
        await extractFundingRounds(pEnv(), b, NOW + 1, { models: model(12) });
      }, activeRead);
      const result = await extractFundingRounds(pEnv(), a, NOW + 2, {
        db,
        models: model(10),
      });
      expect(result).toMatchObject({ status: "done", ignored: 1 });
      const rows = await allRounds();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.superseded_by === null)!.amount).toBe(12);
    },
  );

  it("stale source merge cannot re-add the source of a rejected historical proposal", async () => {
    const original = await seedArticle(),
      d = await seedArticle(),
      a = await seedArticle();
    const model = (amount: number) =>
      fakeModels([
        { companyName: "Acme", roundName: "Seed", amount, currency: "USD" },
      ]).models;
    await extractFundingRounds(pEnv(), original, NOW, { models: model(12) });
    const originalId = (await allRounds())[0].id;
    await decideFundingRound(env.DB, originalId, "published");
    const db = interleaveAfterEmptyRead(async () => {
      await extractFundingRounds(pEnv(), d, NOW + 1, { models: model(10) });
      await extractFundingRounds(pEnv(), a, NOW + 2, { models: model(12) });
      await decideFundingRound(
        env.DB,
        (await allRounds()).at(-1)!.id,
        "rejected",
      );
    });
    expect(
      await extractFundingRounds(pEnv(), a, NOW + 3, { db, models: model(12) }),
    ).toMatchObject({ ignored: 1 });
    const rows = await allRounds();
    expect(rows).toHaveLength(3);
    const active = rows.find((r) => r.superseded_by === null)!;
    expect(active).toMatchObject({
      id: originalId,
      status: "published",
      amount: 12,
    });
    expect(
      JSON.parse(active.source_articles).map(
        (source: { articleId: number }) => source.articleId,
      ),
    ).toEqual([original]);
  });

  it.each([false, true])(
    "historical replay preserves newer facts or a rejected successor (rejected=%s)",
    async (rejected) => {
      const a = await seedArticle(),
        b = await seedArticle();
      const model = (amount: number) =>
        fakeModels([
          { companyName: "Acme", roundName: "Seed", amount, currency: "USD" },
        ]).models;
      const failedId = rejected ? b : a;
      await env.DB.prepare(
        `CREATE TRIGGER fail_marker BEFORE INSERT ON settings WHEN NEW.key LIKE 'funding:done:${failedId}:%' BEGIN SELECT RAISE(ABORT,'marker failed'); END`,
      ).run();
      try {
        if (rejected)
          await extractFundingRounds(pEnv(), a, NOW, { models: model(10) });
        await expect(
          extractFundingRounds(pEnv(), failedId, NOW, {
            models: model(rejected ? 12 : 10),
          }),
        ).rejects.toThrow(/marker failed/);
      } finally {
        await env.DB.prepare("DROP TRIGGER fail_marker").run();
      }
      if (!rejected)
        await extractFundingRounds(pEnv(), b, NOW, { models: model(12) });
      else
        await decideFundingRound(
          env.DB,
          (await allRounds()).at(-1)!.id,
          "rejected",
        );
      await extractFundingRounds(pEnv(), failedId, NOW + 1, {
        models: model(rejected ? 12 : 10),
      });
      const rows = await allRounds();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.superseded_by === null)!.amount).toBe(
        rejected ? 10 : 12,
      );
    },
  );

  it.each([0.5, Number.MAX_SAFE_INTEGER + 1, -1])(
    "rejects unsafe native amount %s before writes",
    async (amount) => {
      const id = await seedArticle();
      await expect(
        extractFundingRounds(pEnv(), id, NOW, {
          models: fakeModels([
            { companyName: "Acme", roundName: "Seed", amount, currency: "USD" },
          ]).models,
        }),
      ).rejects.toThrow(/Invalid funding output/);
      expect(await allRounds()).toEqual([]);
    },
  );

  it("processes a new body version of the same source", async () => {
    const id = await seedArticle();
    const model = (amount: number) =>
      fakeModels([
        { companyName: "Acme", roundName: "Seed", amount, currency: "USD" },
      ]).models;
    await extractFundingRounds(pEnv(), id, NOW, { models: model(10) });
    await env.DB.prepare("UPDATE articles SET body_sha='new-body' WHERE id=?1")
      .bind(id)
      .run();
    await env.DB.prepare(
      "INSERT INTO reviews(article_id,body_sha,decision,reviewer,created_at) VALUES (?1,'new-body','approved','test',0)",
    )
      .bind(id)
      .run();
    await env.BODIES.put(`bodies/${id}/new-body.md`, FUNDING_BODY);
    await extractFundingRounds(pEnv(), id, NOW + 1, { models: model(12) });
    expect(
      (await allRounds()).find((r) => r.superseded_by === null)!.amount,
    ).toBe(12);
  });

  it("only appends provenance for a same-fact report of a published round", async () => {
    const a = await seedArticle();
    const additional: number[] = [];
    for (let i = 0; i < 10; i++) additional.push(await seedArticle());
    const model = fakeModels([
      { companyName: "Acme", roundName: "Seed", amount: 10, currency: "USD" },
    ]).models;
    await extractFundingRounds(pEnv(), a, NOW, { models: model });
    await env.DB.prepare("UPDATE funding_rounds SET status='published'").run();
    const id = (await allRounds())[0].id;
    await Promise.all(
      additional.map((id) =>
        extractFundingRounds(pEnv(), id, NOW, { models: model }),
      ),
    );
    expect(await allRounds()).toMatchObject([
      { id, status: "published", superseded_by: null },
    ]);
    expect(JSON.parse((await allRounds())[0].source_articles)).toHaveLength(11);
  });

  it.each(["revoked", "changed"])(
    "does not append a source whose approval/body is %s",
    async (mode) => {
      const a = await seedArticle(),
        b = await seedArticle();
      const base = fakeModels([
        { companyName: "Acme", roundName: "Seed", amount: 10, currency: "USD" },
      ]).models;
      await extractFundingRounds(pEnv(), a, NOW, { models: base });
      await env.DB.prepare(
        "UPDATE funding_rounds SET status='published'",
      ).run();
      const models: FundingDeps["models"] = {
        generateText: async (...args) => {
          const answer = await base.generateText(...args);
          await env.DB.prepare(
            mode === "revoked"
              ? "UPDATE reviews SET decision='rejected' WHERE article_id=?1"
              : "UPDATE articles SET body_sha='changed' WHERE id=?1",
          )
            .bind(b)
            .run();
          return answer;
        },
      };
      await expect(
        extractFundingRounds(pEnv(), b, NOW, { models }),
      ).rejects.toThrow(/changed/);
      const [row] = await allRounds();
      expect(row.status).toBe("published");
      expect(JSON.parse(row.source_articles)).toHaveLength(1);
    },
  );

  it("holds native-currency conflicts for review despite approximate FX equivalence", async () => {
    for (const [amount, currency] of [
      [13_000_000_000, "USD"],
      [10_000_000_000, "GBP"],
    ] as const) {
      const id = await seedArticle();
      await extractFundingRounds(pEnv(), id, NOW, {
        models: {
          generateText: async () => {
            const batch = v2Envelope({
              rounds: [
                { companyName: "Acme", roundName: "Seed", amount, currency },
              ],
            });
            batch.rounds[0].correctionPatch = {};
            return {
              text: JSON.stringify(batch),
              finishReason: "STOP",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
      });
    }
    expect(await allRounds()).toMatchObject([
      { amount: 13_000_000_000, currency: "USD", amount_micros: null },
    ]);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) n FROM funding_observations WHERE state='unresolved'",
      ).first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it("retains an explicit non-amount correction reason when existing rules create a pending version", async () => {
    for (const [index, investors] of [
      ["a", ["First"]],
      ["b", ["Second"]],
    ] as const) {
      const id = await seedArticle();
      await extractFundingRounds(pEnv(), id, NOW, {
        models: fakeModels([
          {
            companyName: "Acme",
            roundName: "Seed",
            amount: 10,
            currency: "USD",
            investors: [...investors],
            isCorrectionOrUpdate: true,
            correctionReason:
              index === "b" ? "Investor information corrected" : null,
          },
        ]).models,
      });
      if (index === "a")
        await env.DB.prepare(
          "UPDATE funding_rounds SET status='published'",
        ).run();
    }
    expect((await allRounds()).at(-1)!.correction_reason).toBe(
      "Investor information corrected",
    );
  });

  it.each(["MAX_TOKENS", "SAFETY"])(
    "rejects %s without business writes",
    async (finishReason) => {
      const id = await seedArticle();
      const { models } = fakeModels([
        { companyName: "Acme", roundName: "Seed" },
      ]);
      const generateText: FundingDeps["models"]["generateText"] = async (
        ...args
      ) => ({
        ...(await models.generateText(...args)),
        finishReason,
      });
      await expect(
        extractFundingRounds(pEnv(), id, NOW, { models: { generateText } }),
      ).rejects.toThrow(/STOP/);
      expect(await allRounds()).toEqual([]);
      expect(
        await env.DB.prepare(
          "SELECT key FROM settings WHERE key LIKE 'funding:done:%'",
        ).all(),
      ).toMatchObject({ results: [] });
    },
  );

  it("rechecks the approved body after the model answers", async () => {
    const id = await seedArticle();
    const fake = fakeModels([{ companyName: "Acme", roundName: "Seed" }]);
    const models: FundingDeps["models"] = {
      generateText: async (...args) => {
        const result = await fake.models.generateText(...args);
        await env.DB.prepare(
          "UPDATE reviews SET decision = 'rejected' WHERE article_id = ?1",
        )
          .bind(id)
          .run();
        return result;
      },
    };
    await expect(
      extractFundingRounds(pEnv(), id, NOW, { models }),
    ).rejects.toThrow(/approved|changed/i);
    expect(await allRounds()).toEqual([]);
  });

  it("concurrent reports merge every investor and source, and duplicate replay is inert", async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await seedArticle());
    const runs = ids.map((id, i) =>
      extractFundingRounds(pEnv(), id, NOW, {
        models: fakeModels([
          {
            companyName: "Acme",
            roundName: "Seed",
            amount: 10,
            currency: "USD",
            investors: [`Investor ${i}`],
          },
        ]).models,
      }),
    );
    await Promise.all(runs);
    const rows = await allRounds();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].source_articles)).toHaveLength(10);
    expect(JSON.parse(rows[0].investors)).toHaveLength(10);
    await env.DB.prepare(
      "UPDATE funding_rounds SET status = 'published'",
    ).run();
    await extractFundingRounds(pEnv(), ids[0], NOW + 1, {
      models: fakeModels([
        {
          companyName: "Acme",
          roundName: "Seed",
          amount: 10,
          currency: "USD",
          investors: ["Investor 0"],
        },
      ]).models,
    });
    expect(await allRounds()).toHaveLength(1);
  });

  it("ten reports of one round leave one active record with all sources", async () => {
    const investorsByReport = [
      ["Alpha Ventures"],
      ["alpha ventures", "Beta Capital"],
      ["Gamma Partners"],
    ];
    for (let i = 0; i < 10; i++) {
      const id = await seedArticle();
      const { models } = fakeModels([
        {
          companyName: i % 2 ? "Acme AI" : "Acme AI, Inc.",
          roundName: i % 3 ? "Series A" : "series a",
          amount: 12_000_000,
          currency: "USD",
          sector: "ai_infrastructure",
          investors: investorsByReport[i % 3],
          announcedDate: "2026-10-19",
        },
      ]);
      await extractFundingRounds(pEnv(), id, NOW + i, { models });
    }
    const rows = await allRounds();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.superseded_by).toBeNull();
    expect(row.company_key).toBe("entity:acme-ai");
    expect(row.round_key).toBe("event:series_a:2026-10-19");
    expect(row.status).toBe("pending_review");
    expect(row.amount_micros).toBe(12_000_000_000_000);
    expect(JSON.parse(row.source_articles)).toHaveLength(10);
    expect(JSON.parse(row.investors)).toEqual([
      "Alpha Ventures",
      "Beta Capital",
      "Gamma Partners",
    ]);
  });

  it("reading the same article twice does not duplicate its source", async () => {
    const id = await seedArticle();
    const { models } = fakeModels([
      {
        companyName: "Acme AI",
        roundName: "Seed",
        amount: 1_000_000,
        currency: "USD",
      },
    ]);
    await extractFundingRounds(pEnv(), id, NOW, { models });
    await extractFundingRounds(pEnv(), id, NOW + 1, { models });
    const rows = await allRounds();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].source_articles)).toHaveLength(1);
  });

  it("always inserts as pending_review", async () => {
    const id = await seedArticle();
    const { models } = fakeModels([
      {
        companyName: "Acme AI",
        roundName: "Seed",
        amount: 1_000_000,
        currency: "USD",
      },
    ]);
    await extractFundingRounds(pEnv(), id, NOW, { models });
    expect((await allRounds())[0].status).toBe("pending_review");
  });

  it("an amount that differs becomes a new version; the old row is kept", async () => {
    const first = await seedArticle();
    await extractFundingRounds(pEnv(), first, NOW, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Series A",
          amount: 10_000_000,
          currency: "USD",
          investors: ["Alpha"],
        },
      ]).models,
    });
    await env.DB.prepare(
      "UPDATE funding_rounds SET status = 'published'",
    ).run();

    const second = await seedArticle();
    const result = await extractFundingRounds(pEnv(), second, NOW + 1, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Series A",
          amount: 12_000_000,
          currency: "USD",
          investors: ["Beta"],
          isCorrectionOrUpdate: true,
          correctionReason: "Earlier report understated the amount.",
        },
      ]).models,
    });
    expect(result).toMatchObject({ status: "done", superseded: 1 });

    const rows = await allRounds();
    expect(rows).toHaveLength(2);
    const [old, next] = rows;
    expect(old.amount).toBe(10_000_000);
    expect(old.status).toBe("published");
    expect(old.superseded_by).toBe(next.id);
    expect(next.superseded_by).toBeNull();
    expect(next.amount).toBe(12_000_000);
    expect(next.status).toBe("pending_review");
    expect(next.correction_reason).toBe(
      "Earlier report understated the amount.",
    );
    expect(JSON.parse(next.investors)).toEqual(["Alpha", "Beta"]);
    expect(JSON.parse(next.source_articles)).toHaveLength(2);

    // Only one active row for the key.
    const active = await env.DB.prepare(
      "SELECT count(*) AS n FROM funding_rounds WHERE superseded_by IS NULL",
    ).first<{ n: number }>();
    expect(active!.n).toBe(1);
  });

  it("a different amount supersedes even if the model did not flag a correction", async () => {
    const a = await seedArticle();
    await extractFundingRounds(pEnv(), a, NOW, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Seed",
          amount: 5_000_000,
          currency: "USD",
        },
      ]).models,
    });
    const b = await seedArticle();
    await extractFundingRounds(pEnv(), b, NOW + 1, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Seed",
          amount: 6_000_000,
          currency: "USD",
        },
      ]).models,
    });
    const rows = await allRounds();
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(5_000_000);
    expect(rows[1].amount).toBe(6_000_000);
    expect(rows[1].correction_reason).toMatch(/^Amount revised per https:\/\//);
  });

  it("new facts on a published record go to a new pending version, not in place", async () => {
    const a = await seedArticle();
    await extractFundingRounds(pEnv(), a, NOW, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Seed",
          amount: 5_000_000,
          currency: "USD",
          investors: ["Alpha"],
        },
      ]).models,
    });
    await env.DB.prepare(
      "UPDATE funding_rounds SET status = 'published'",
    ).run();
    const b = await seedArticle();
    await extractFundingRounds(pEnv(), b, NOW + 1, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Seed",
          amount: 5_000_000,
          currency: "USD",
          investors: ["Alpha", "Beta"],
        },
      ]).models,
    });
    const rows = await allRounds();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].investors)).toEqual(["Alpha"]);
    expect(rows[0].status).toBe("published");
    expect(rows[1].status).toBe("pending_review");
    expect(JSON.parse(rows[1].investors)).toEqual(["Alpha", "Beta"]);
  });

  it("a rejected record is not amended or revived", async () => {
    const a = await seedArticle();
    await extractFundingRounds(pEnv(), a, NOW, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Seed",
          amount: 5_000_000,
          currency: "USD",
        },
      ]).models,
    });
    await env.DB.prepare("UPDATE funding_rounds SET status = 'rejected'").run();
    const b = await seedArticle();
    const result = await extractFundingRounds(pEnv(), b, NOW + 1, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Seed",
          amount: 9_000_000,
          currency: "USD",
        },
      ]).models,
    });
    expect(result).toMatchObject({ status: "done", ignored: 1 });
    const rows = await allRounds();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
  });

  it("an undisclosed amount, currency and date still store", async () => {
    const id = await seedArticle();
    const { models } = fakeModels([
      {
        companyName: "Quiet Co",
        roundName: "a mystery round",
        amount: 5_000_000,
        currency: null,
        sector: "unheard of",
        announcedDate: null,
      },
    ]);
    await extractFundingRounds(pEnv(), id, NOW, { models });
    expect(await allRounds()).toEqual([]);
    const observation = await env.DB.prepare(
      "SELECT state,payload_json FROM funding_observations",
    ).first<{ state: string; payload_json: string }>();
    expect(observation!.state).toBe("unresolved");
    expect(
      JSON.parse(observation!.payload_json).identity.announcedDate,
    ).toBeNull();
  });

  it("an amount may be filled later on an unpublished record", async () => {
    const a = await seedArticle();
    await extractFundingRounds(pEnv(), a, NOW, {
      models: fakeModels([
        { companyName: "Acme AI", roundName: "Seed", amount: null },
      ]).models,
    });
    const b = await seedArticle();
    await extractFundingRounds(pEnv(), b, NOW + 1, {
      models: fakeModels([
        {
          companyName: "Acme AI",
          roundName: "Seed",
          amount: 3_000_000,
          currency: "EUR",
        },
      ]).models,
    });
    const rows = await allRounds();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(3_000_000);
    expect(rows[0].currency).toBe("EUR");
    expect(rows[0].amount_micros).toBe(3_240_000_000_000);
  });

  it("skips rounds the model says are not announcements and bad output", async () => {
    const a = await seedArticle();
    const first = await extractFundingRounds(pEnv(), a, NOW, {
      models: fakeModels([
        {
          isFundingAnnouncement: false,
          companyName: "Rumour Co",
          roundName: "Seed",
        },
      ]).models,
    });
    expect(first).toMatchObject({ status: "done", inserted: 0 });
    const b = await seedArticle();
    await expect(
      extractFundingRounds(pEnv(), b, NOW, {
        models: fakeModels("not json at all").models,
      }),
    ).rejects.toThrow(/invalid funding output/i);
    expect(await allRounds()).toHaveLength(0);
  });

  it("does not call the model for an unapproved article or a non-Finance one", async () => {
    const { models, calls } = fakeModels([
      { companyName: "Acme AI", roundName: "Seed" },
    ]);
    const unapproved = await seedArticle({ approved: false });
    expect(
      await extractFundingRounds(pEnv(), unapproved, NOW, { models }),
    ).toMatchObject({ status: "skipped", reason: "not_approved_finance" });
    const tech = await seedIndustry("technology");
    const other = await seedArticle({ industryId: tech });
    expect(
      await extractFundingRounds(pEnv(), other, NOW, { models }),
    ).toMatchObject({ status: "skipped", reason: "not_approved_finance" });
    expect(calls).toHaveLength(0);
  });

  it("does not call the model while MODEL_CALLS_ENABLED is off", async () => {
    const id = await seedArticle();
    const { models, calls } = fakeModels([
      { companyName: "Acme AI", roundName: "Seed" },
    ]);
    const result = await extractFundingRounds(pEnv({}), id, NOW, { models });
    expect(result).toMatchObject({
      status: "skipped",
      reason: "model_calls_disabled",
    });
    expect(calls).toHaveLength(0);
  });

  it("a second run with the real ledger does not call the model again", async () => {
    const id = await seedArticle();
    let transportCalls = 0;
    const transport: ModelTransport = {
      run: async () => {
        transportCalls += 1;
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify(
                      v2Envelope({
                        rounds: [
                          {
                            isFundingAnnouncement: true,
                            companyName: "Acme AI",
                            roundName: "Seed",
                            amount: 1_000_000,
                            currency: "USD",
                          },
                        ],
                      }),
                    ),
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
        };
      },
    };
    await extractFundingRounds(pEnv(), id, NOW, { transport });
    await extractFundingRounds(pEnv(), id, NOW + 1, { transport });
    expect(transportCalls).toBe(1);
    expect(await allRounds()).toHaveLength(1);
  });
});

describe("enqueueDueFunding", () => {
  function queueEnv(flags: Record<string, string> = ON) {
    const sent: GenerateMessage[] = [];
    const e = {
      DB: env.DB,
      Q_GENERATE: {
        sendBatch: async (msgs: Iterable<{ body: GenerateMessage }>) => {
          sent.push(...[...msgs].map((m) => m.body));
        },
      },
      ...flags,
    } as unknown as PipelineEnv;
    return { e, sent };
  }

  it("queues approved funding articles that have no completed extraction", async () => {
    const funding = await seedArticle();
    await seedArticle({ approved: false });
    await seedArticle({ fundingType: false });
    const { e, sent } = queueEnv();
    expect(await enqueueDueFunding(e, NOW)).toEqual([funding]);
    expect(sent).toEqual([{ kind: "funding", articleId: funding }]);
  });

  it("requeues completed ledger output after a DB failure and reuses the cached answer", async () => {
    const first = await seedArticle();
    await extractFundingRounds(pEnv(), first, NOW, {
      models: fakeModels([
        { companyName: "Acme", roundName: "Seed", amount: 5, currency: "USD" },
      ]).models,
    });
    await env.DB.prepare(
      "UPDATE funding_rounds SET status = 'published'",
    ).run();
    const id = await seedArticle();
    let calls = 0;
    const transport: ModelTransport = {
      run: async () => {
        calls++;
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify(
                      v2Envelope({
                        rounds: [
                          {
                            isFundingAnnouncement: true,
                            companyName: "Acme",
                            roundName: "Seed",
                            amount: 10,
                            currency: "USD",
                          },
                          {
                            isFundingAnnouncement: true,
                            companyName: "Broken",
                            roundName: "Seed",
                            amount: 1,
                            currency: "USD",
                          },
                        ],
                      }),
                    ),
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
      },
    };
    await env.DB.prepare(
      "CREATE TRIGGER funding_fail BEFORE INSERT ON funding_rounds WHEN NEW.company_name = 'Broken' BEGIN SELECT RAISE(ABORT, 'business failure'); END",
    ).run();
    try {
      await expect(
        extractFundingRounds(pEnv(), id, NOW, { transport }),
      ).rejects.toThrow(/business failure/);
    } finally {
      await env.DB.prepare("DROP TRIGGER funding_fail").run();
    }
    const { e } = queueEnv();
    expect(await enqueueDueFunding(e, NOW)).toEqual([id]);
    await extractFundingRounds(pEnv(), id, NOW + 1, { transport });
    expect(calls).toBe(1);
    expect(await allRounds()).toHaveLength(3);
    expect(
      (await env.DB.prepare("SELECT count(*) n FROM corrections").first<{
        n: number;
      }>())!.n,
    ).toBe(1);
    expect(await enqueueDueFunding(e, NOW)).toEqual([]);
    const article = await env.DB.prepare(
      "SELECT body_sha FROM articles WHERE id = ?1",
    )
      .bind(id)
      .first<{ body_sha: string }>();
    expect(
      await env.DB.prepare("SELECT key FROM settings WHERE key = ?1")
        .bind(fundingCompletionKey(id, article!.body_sha))
        .first(),
    ).not.toBeNull();
  });

  it("stops queueing an article once its extraction completed", async () => {
    const id = await seedArticle();
    const transport: ModelTransport = {
      run: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: '{"version":2,"rounds":[]}' }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
    };
    const { e } = queueEnv();
    expect(await enqueueDueFunding(e, NOW)).toEqual([id]);
    await extractFundingRounds(pEnv(), id, NOW, { transport });
    expect(await enqueueDueFunding(e, NOW)).toEqual([]);
  });

  it("queues nothing while MODEL_CALLS_ENABLED is off", async () => {
    await seedArticle();
    const { e, sent } = queueEnv({});
    expect(await enqueueDueFunding(e, NOW)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("the generate consumer routes a funding message to the extractor", async () => {
    const id = await seedArticle();
    const transport: ModelTransport = {
      run: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: JSON.stringify(
                    v2Envelope({
                      rounds: [
                        {
                          isFundingAnnouncement: true,
                          companyName: "Acme AI",
                          roundName: "Seed",
                          amount: 1_000_000,
                          currency: "USD",
                        },
                      ],
                    }),
                  ),
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
    };
    let acked = 0;
    await handleGenerateBatch(
      {
        queue: "ainews-generate",
        messages: [
          {
            body: { kind: "funding", articleId: id },
            ack: () => (acked += 1),
            retry: () => {
              throw new Error("retry");
            },
          },
        ],
      } as unknown as MessageBatch<GenerateMessage>,
      pEnv(),
      { transport },
    );
    expect(acked).toBe(1);
    expect(await allRounds()).toHaveLength(1);
  });
});
