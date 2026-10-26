// Issue #83: financial_facts.superseded_by is written by decideReview when a
// 10-Q/A or 10-K/A article is approved, and handed back when it is rejected or
// retracted. Ingest itself never writes it.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ingestCompanyFilings } from "../../src/pipeline/edgar/ingest";
import type { PipelineEnv } from "../../src/pipeline/messages";
import { decideReview, retractArticle } from "../../src/server/admin/ops";
import { APPROVED_ARTICLE_SQL } from "../../src/server/publication/articles";
import { NOW, resetPipeline } from "../pipeline/helpers";

const BODY_SHA = "sha-orig";
const REVIEWER = "admin@example.com";
const PERIOD = "2024-06-29";

interface Ctx {
  industryId: number;
  sourceId: number;
  companyId: number;
}

interface FactSeed {
  concept: string;
  unit: string;
  periodEnd: string;
}

async function seedBase(): Promise<Ctx> {
  const ind = await env.DB.prepare(
    "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('finance', 'Finance', 'review', 0) RETURNING id",
  ).first<{ id: number }>();
  const src = await env.DB.prepare(
    "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'SEC EDGAR', 'https://data.sec.gov/submissions/', 'html', 'active', 0) RETURNING id",
  )
    .bind(ind!.id)
    .first<{ id: number }>();
  const comp = await env.DB.prepare(
    "INSERT INTO companies (cik, ticker, name, tracked, created_at, updated_at) VALUES ('0000320193', 'AAPL', 'Apple Inc.', 1, 0, 0) RETURNING id",
  ).first<{ id: number }>();
  return { industryId: ind!.id, sourceId: src!.id, companyId: comp!.id };
}

/** One filing = one article + one filings row + its facts. */
async function seedFiling(
  ctx: Ctx,
  accn: string,
  form: string,
  facts: FactSeed[],
): Promise<{ articleId: number; factIds: number[] }> {
  const url = `https://www.sec.gov/Archives/edgar/data/320193/${accn}.htm`;
  const art = await env.DB.prepare(
    `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
     VALUES (?1, ?2, ?3, ?3, ?4, 'analyzed', 0, ?5, 0)
     RETURNING id`,
  )
    .bind(ctx.sourceId, ctx.industryId, url, `AAPL ${form}`, BODY_SHA)
    .first<{ id: number }>();
  const filing = await env.DB.prepare(
    `INSERT INTO filings (company_id, accession_number, form, filing_date, sec_url, article_id, status, created_at)
     VALUES (?1, ?2, ?3, '2024-08-02', ?4, ?5, 'processed', 0)
     RETURNING id`,
  )
    .bind(ctx.companyId, accn, form, url, art!.id)
    .first<{ id: number }>();
  const factIds: number[] = [];
  for (const f of facts) {
    const row = await env.DB.prepare(
      `INSERT INTO financial_facts (company_id, filing_id, accession_number, taxonomy, concept, unit, val, period_end, filed_date, sec_url, created_at)
       VALUES (?1, ?2, ?3, 'us-gaap', ?4, ?5, '1', ?6, '2024-08-02', ?7, 0)
       RETURNING id`,
    )
      .bind(
        ctx.companyId,
        filing!.id,
        accn,
        f.concept,
        f.unit,
        f.periodEnd,
        url,
      )
      .first<{ id: number }>();
    factIds.push(row!.id);
  }
  return { articleId: art!.id, factIds };
}

async function supersededBy(factId: number): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT superseded_by FROM financial_facts WHERE id = ?1",
  )
    .bind(factId)
    .first<{ superseded_by: number | null }>();
  return row!.superseded_by;
}

async function decide(
  articleId: number,
  decision: "approved" | "rejected",
  bodySha = BODY_SHA,
): Promise<void> {
  await decideReview(env.DB, {
    articleId,
    bodySha,
    decision,
    reviewer: REVIEWER,
  });
}

const revenueUsd: FactSeed = {
  concept: "Revenues",
  unit: "USD",
  periodEnd: PERIOD,
};

/** Original 10-Q (fact O1) and a 10-Q/A (fact A1), same concept/unit/period. */
async function seedOriginalAndAmendment(ctx: Ctx) {
  const original = await seedFiling(ctx, "0000320193-24-000001", "10-Q", [
    revenueUsd,
  ]);
  const amendment = await seedFiling(ctx, "0000320193-24-000002", "10-Q/A", [
    revenueUsd,
  ]);
  return {
    o1: original.factIds[0],
    a1: amendment.factIds[0],
    amendmentArticleId: amendment.articleId,
  };
}

/** Original O1, then amendment A (A1), then amendment B (B1 > A1). */
async function seedTwoAmendments(ctx: Ctx) {
  const original = await seedFiling(ctx, "0000320193-24-000001", "10-Q", [
    revenueUsd,
  ]);
  const a = await seedFiling(ctx, "0000320193-24-000002", "10-Q/A", [
    revenueUsd,
  ]);
  const b = await seedFiling(ctx, "0000320193-24-000003", "10-Q/A", [
    revenueUsd,
  ]);
  expect(b.factIds[0]).toBeGreaterThan(a.factIds[0]);
  return {
    o1: original.factIds[0],
    a1: a.factIds[0],
    b1: b.factIds[0],
    aArticleId: a.articleId,
    bArticleId: b.articleId,
  };
}

/** Original O1, then amendments A, B, C (ids ascending: A1 < B1 < C1). */
async function seedThreeAmendments(ctx: Ctx) {
  const original = await seedFiling(ctx, "0000320193-24-000001", "10-Q", [
    revenueUsd,
  ]);
  const a = await seedFiling(ctx, "0000320193-24-000002", "10-Q/A", [
    revenueUsd,
  ]);
  const b = await seedFiling(ctx, "0000320193-24-000003", "10-Q/A", [
    revenueUsd,
  ]);
  const c = await seedFiling(ctx, "0000320193-24-000004", "10-Q/A", [
    revenueUsd,
  ]);
  expect(b.factIds[0]).toBeGreaterThan(a.factIds[0]);
  expect(c.factIds[0]).toBeGreaterThan(b.factIds[0]);
  return {
    o1: original.factIds[0],
    a1: a.factIds[0],
    b1: b.factIds[0],
    c1: c.factIds[0],
    oArticleId: original.articleId,
    aArticleId: a.articleId,
    bArticleId: b.articleId,
    cArticleId: c.articleId,
  };
}

describe("financial_facts.superseded_by follows amendment review (Issue #83)", () => {
  it("approving a 10-Q/A supersedes earlier facts with the same concept, unit and period", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const original = await seedFiling(ctx, "0000320193-24-000001", "10-Q", [
      revenueUsd,
      { concept: "Revenues", unit: "shares", periodEnd: PERIOD },
    ]);
    const amendment = await seedFiling(ctx, "0000320193-24-000002", "10-Q/A", [
      revenueUsd,
    ]);
    const [o1, o2] = original.factIds;
    const a1 = amendment.factIds[0];

    expect(await supersededBy(o1)).toBeNull();
    expect(await supersededBy(o2)).toBeNull();
    expect(await supersededBy(a1)).toBeNull();

    await decide(amendment.articleId, "approved");
    expect(await supersededBy(o1)).toBe(a1);
    expect(await supersededBy(o2)).toBeNull();
    expect(await supersededBy(a1)).toBeNull();

    // Approving again changes nothing.
    await decide(amendment.articleId, "approved");
    expect(await supersededBy(o1)).toBe(a1);
    expect(await supersededBy(o2)).toBeNull();
    expect(await supersededBy(a1)).toBeNull();
  });

  it("rejecting an unreviewed 10-Q/A leaves earlier facts active", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, amendmentArticleId } = await seedOriginalAndAmendment(ctx);

    await decide(amendmentArticleId, "rejected");
    expect(await supersededBy(o1)).toBeNull();
  });

  it("retracting an approved 10-Q/A restores earlier facts", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, a1, amendmentArticleId } = await seedOriginalAndAmendment(ctx);

    await decide(amendmentArticleId, "approved");
    expect(await supersededBy(o1)).toBe(a1);

    await retractArticle(env.DB, amendmentArticleId, REVIEWER);
    expect(await supersededBy(o1)).toBeNull();
  });

  it("approving a later non-amended filing does not supersede earlier facts", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const original = await seedFiling(ctx, "0000320193-24-000001", "10-Q", [
      revenueUsd,
    ]);
    // The next quarter's 10-Q carries the prior period as a comparative.
    const later = await seedFiling(ctx, "0000320193-24-000005", "10-Q", [
      revenueUsd,
    ]);

    await decide(later.articleId, "approved");
    expect(await supersededBy(original.factIds[0])).toBeNull();
  });

  it("retracting a middle amendment hands earlier facts to the newer approved amendment", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, b1, aArticleId, bArticleId } = await seedTwoAmendments(ctx);

    await decide(aArticleId, "approved");
    await decide(bArticleId, "approved");
    await retractArticle(env.DB, aArticleId, REVIEWER);

    expect(await supersededBy(o1)).toBe(b1);
    expect(await supersededBy(b1)).toBeNull();
  });

  it("approving an older amendment after a newer one keeps the newer fact active", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, a1, b1, aArticleId, bArticleId } = await seedTwoAmendments(ctx);

    await decide(bArticleId, "approved");
    await decide(aArticleId, "approved");

    expect(await supersededBy(o1)).toBe(b1);
    expect(await supersededBy(a1)).toBe(b1);
    expect(await supersededBy(b1)).toBeNull();
  });

  it("approve then reject returns superseded_by to NULL", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, a1, amendmentArticleId } = await seedOriginalAndAmendment(ctx);

    await decide(amendmentArticleId, "approved");
    expect(await supersededBy(o1)).toBe(a1);

    await decide(amendmentArticleId, "rejected");
    expect(await supersededBy(o1)).toBeNull();
  });

  it("rejecting the newer of two amendments points back at the older one", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, a1, b1, aArticleId, bArticleId } = await seedTwoAmendments(ctx);

    await decide(aArticleId, "approved");
    await decide(bArticleId, "approved");
    // Both approved: every earlier fact points at the newest approved one.
    expect(await supersededBy(o1)).toBe(b1);
    expect(await supersededBy(a1)).toBe(b1);

    await decide(bArticleId, "rejected");
    expect(await supersededBy(a1)).toBeNull();
    expect(await supersededBy(o1)).toBe(a1);
  });

  it("re-approving an amendment does not move earlier facts past it", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, a1, b1, aArticleId, bArticleId } = await seedTwoAmendments(ctx);

    await decide(aArticleId, "approved");
    await decide(bArticleId, "approved");
    await decide(aArticleId, "approved");
    // Both approved: every earlier fact points at the newest approved one.
    expect(await supersededBy(o1)).toBe(b1);
    expect(await supersededBy(a1)).toBe(b1);

    await decide(bArticleId, "rejected");
    expect(await supersededBy(a1)).toBeNull();
    expect(await supersededBy(o1)).toBe(a1);
  });

  it("approve B, approve A, reject B points O1 at A1", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, a1, aArticleId, bArticleId } = await seedTwoAmendments(ctx);

    await decide(bArticleId, "approved");
    await decide(aArticleId, "approved");
    await decide(bArticleId, "rejected");

    expect(await supersededBy(o1)).toBe(a1);
    expect(await supersededBy(a1)).toBeNull();
  });

  it("approve O, B, A then reject B keeps O1 on A1 (codex sequence)", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const original = await seedFiling(ctx, "0000320193-24-000001", "10-Q", [
      revenueUsd,
    ]);
    const a = await seedFiling(ctx, "0000320193-24-000002", "10-Q/A", [
      revenueUsd,
    ]);
    const b = await seedFiling(ctx, "0000320193-24-000003", "10-Q/A", [
      revenueUsd,
    ]);
    const o1 = original.factIds[0];
    const a1 = a.factIds[0];

    await decide(original.articleId, "approved");
    await decide(b.articleId, "approved");
    await decide(a.articleId, "approved");
    await decide(b.articleId, "rejected");

    expect(await supersededBy(o1)).toBe(a1);
    expect(await supersededBy(a1)).toBeNull();
  });

  it("approve C, A, B then reject C points earlier facts at B1", async () => {
    await resetPipeline();
    const ctx = await seedBase();
    const { o1, a1, b1, c1, aArticleId, bArticleId, cArticleId } =
      await seedThreeAmendments(ctx);

    await decide(cArticleId, "approved");
    await decide(aArticleId, "approved");
    await decide(bArticleId, "approved");
    await decide(cArticleId, "rejected");

    expect(await supersededBy(o1)).toBe(b1);
    expect(await supersededBy(a1)).toBe(b1);
    expect(await supersededBy(b1)).toBeNull();
    expect(await supersededBy(c1)).toBeNull();
  });

  it("the same final review state gives the same superseded_by in any decision order", async () => {
    const run = async (
      order: (ids: {
        aArticleId: number;
        bArticleId: number;
        cArticleId: number;
      }) => Promise<void>,
    ) => {
      await resetPipeline();
      const ctx = await seedBase();
      const seeded = await seedThreeAmendments(ctx);
      await order(seeded);
      // Ids differ between runs, so compare pointers by role.
      const role = new Map<number, string>([
        [seeded.o1, "O1"],
        [seeded.a1, "A1"],
        [seeded.b1, "B1"],
        [seeded.c1, "C1"],
      ]);
      const out: Record<string, string | null> = {};
      for (const [id, name] of role) {
        const target = await supersededBy(id);
        out[name] = target === null ? null : (role.get(target) ?? `?${target}`);
      }
      return out;
    };

    // Final state in both runs: A approved, B approved, C rejected.
    const first = await run(async ({ aArticleId, bArticleId, cArticleId }) => {
      await decide(cArticleId, "approved");
      await decide(aArticleId, "approved");
      await decide(bArticleId, "approved");
      await decide(cArticleId, "rejected");
    });
    const second = await run(async ({ aArticleId, bArticleId, cArticleId }) => {
      await decide(cArticleId, "rejected");
      await decide(bArticleId, "approved");
      await decide(aArticleId, "approved");
    });

    expect(first).toEqual(second);
  });

  it("re-ingest of an approved amendment with a changed body keeps the original hidden and the amendment non-public until re-approved", async () => {
    await resetPipeline();
    await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('finance', 'Finance', 'review', 0)",
    ).run();
    const comp = await env.DB.prepare(
      "INSERT INTO companies (cik, ticker, name, tracked, created_at, updated_at) VALUES ('0000320193', 'AAPL', 'Apple Inc.', 1, ?1, ?1) RETURNING id",
    )
      .bind(NOW)
      .first<{ id: number }>();
    const companyId = comp!.id;

    const ORIG = "0000320193-24-000001";
    const AMEND = "0000320193-24-000002";
    const submissionsFor = (accn: string, form: string, doc: string) => ({
      cik: "0000320193",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      filings: {
        recent: {
          accessionNumber: [accn],
          filingDate: ["2024-08-02"],
          reportDate: [PERIOD],
          acceptanceDateTime: ["2024-08-02T18:00:00.000Z"],
          form: [form],
          items: [""],
          primaryDocument: [doc],
        },
      },
    });
    const factEntry = (accn: string, form: string, val: number) => ({
      end: PERIOD,
      val,
      fy: 2024,
      fp: "Q3",
      form,
      filed: "2024-08-02",
      accn,
    });
    const companyFacts = {
      cik: 320193,
      entityName: "Apple Inc.",
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            label: "Total Net Sales",
            description: "",
            units: {
              USD: [
                factEntry(ORIG, "10-Q", 85777000000),
                factEntry(AMEND, "10-Q/A", 85800000000),
              ],
            },
          },
        },
      },
    };

    let submissions = submissionsFor(ORIG, "10-Q", "aapl-20240629.htm");
    let amendmentDocStatus = 503;
    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("submissions")) {
        return new Response(JSON.stringify(submissions), { status: 200 });
      }
      if (url.includes("companyfacts")) {
        return new Response(JSON.stringify(companyFacts), { status: 200 });
      }
      if (url.includes("aapl-20240629a.htm")) {
        if (amendmentDocStatus !== 200) {
          return new Response("Service Unavailable", {
            status: amendmentDocStatus,
          });
        }
        return new Response(
          "<html><body>Apple Restated Q3 Results</body></html>",
          { status: 200 },
        );
      }
      return new Response("<html><body>Apple Q3 Results</body></html>", {
        status: 200,
      });
    });
    const mockEnv = {
      DB: env.DB,
      BODIES: env.BODIES,
      SEC_USER_AGENT: "Daily test@example.com",
      COLLECT_ENABLED: "true",
    } as unknown as PipelineEnv;
    const deps = { fetch: fakeFetch, sleep: async () => {} };

    // Original 10-Q, then the 10-Q/A whose document fetch fails: the filing is
    // stored as 'failed' with a fallback body, so a later poll retries it.
    await ingestCompanyFilings(mockEnv, companyId, NOW, deps);
    submissions = submissionsFor(AMEND, "10-Q/A", "aapl-20240629a.htm");
    await ingestCompanyFilings(mockEnv, companyId, NOW + 1000, deps);

    const factId = async (accn: string) =>
      (await env.DB.prepare(
        "SELECT id FROM financial_facts WHERE accession_number = ?1",
      )
        .bind(accn)
        .first<{ id: number }>())!.id;
    const o1 = await factId(ORIG);
    const a1 = await factId(AMEND);
    const amendmentArticle = async () =>
      (await env.DB.prepare(
        `SELECT a.id, a.body_sha FROM articles a
         JOIN filings f ON f.article_id = a.id
         WHERE f.accession_number = ?1`,
      )
        .bind(AMEND)
        .first<{ id: number; body_sha: string }>())!;
    const isApproved = async (articleId: number) =>
      (await env.DB.prepare(
        `SELECT 1 AS ok FROM articles a WHERE a.id = ?1 AND ${APPROVED_ARTICLE_SQL}`,
      )
        .bind(articleId)
        .first()) !== null;

    // Ingest alone does not hide the original.
    expect(await supersededBy(o1)).toBeNull();

    const before = await amendmentArticle();
    await decide(before.id, "approved", before.body_sha);
    expect(await isApproved(before.id)).toBe(true);
    expect(await supersededBy(o1)).toBe(a1);

    // Retry succeeds with the real document: the body changes.
    amendmentDocStatus = 200;
    await ingestCompanyFilings(mockEnv, companyId, NOW + 2000, deps);
    const after = await amendmentArticle();
    expect(after.id).toBe(before.id);
    expect(after.body_sha).not.toBe(before.body_sha);

    // (a) the original stays hidden; (b) the amendment is not public.
    expect(await supersededBy(o1)).toBe(a1);
    expect(await isApproved(after.id)).toBe(false);

    // (c) approving the new body makes it public again.
    await decide(after.id, "approved", after.body_sha);
    expect(await isApproved(after.id)).toBe(true);
    expect(await supersededBy(o1)).toBe(a1);
  });
});
