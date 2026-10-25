import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  edgarFetch,
  formatCik10,
  type EdgarCompanyFactsResponse,
} from "../../src/pipeline/edgar/client";
import type { PipelineEnv } from "../../src/pipeline/messages";
import {
  compareFinancialMetrics,
  formatDeltaPercent,
  type FactWithMetadata,
} from "../../src/pipeline/edgar/comparator";
import { ingestCompanyFilings } from "../../src/pipeline/edgar/ingest";
import { pollDueCompanies } from "../../src/pipeline/edgar/schedule";
import {
  extractFactsForFiling,
  findHistoricalFact,
} from "../../src/pipeline/edgar/xbrl";
import { resetPipeline, seedIndustry, NOW } from "./helpers";

describe("EDGAR Client & SEC Compliance", () => {
  it("formats CIK to 10 digits zero-padded string", () => {
    expect(formatCik10("320193")).toBe("0000320193");
    expect(formatCik10(1045810)).toBe("0001045810");
    expect(formatCik10("0000320193")).toBe("0000320193");
  });

  it("fails if SEC_USER_AGENT is not configured", async () => {
    await expect(
      edgarFetch(
        "https://data.sec.gov/submissions/CIK0000320193.json",
        {
          DB: env.DB,
          SEC_USER_AGENT: undefined,
        },
        NOW,
      ),
    ).rejects.toThrow("SEC_USER_AGENT is not configured");
  });

  it("sends fetch request with SEC_USER_AGENT header and claims host slot", async () => {
    let capturedHeaders: Headers | undefined;
    const fakeFetch = vi
      .fn()
      .mockImplementation(async (_url: string, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({ cik: "0000320193", entityType: "operating" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

    const res = await edgarFetch(
      "https://data.sec.gov/submissions/CIK0000320193.json",
      {
        DB: env.DB,
        SEC_USER_AGENT: "Personal News test@example.com",
      },
      NOW,
      { fetch: fakeFetch },
    );

    expect(res.status).toBe(200);
    expect(capturedHeaders?.get("User-Agent")).toBe(
      "Personal News test@example.com",
    );
  });
});

describe("XBRL Normalization & Fact Extraction", () => {
  const sampleCompanyFacts = {
    cik: 320193,
    entityName: "Apple Inc.",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          label: "Total Net Sales",
          description: "Revenue from goods and services",
          units: {
            USD: [
              {
                end: "2024-09-28",
                val: 94930000000,
                fy: 2024,
                fp: "Q4",
                form: "10-K",
                filed: "2024-11-01",
                accn: "0000320193-24-000106",
              },
              {
                end: "2023-09-30",
                val: 89498000000,
                fy: 2023,
                fp: "Q4",
                form: "10-K",
                filed: "2023-11-03",
                accn: "0000320193-23-000106",
              },
            ],
          },
        },
        OperatingIncomeLoss: {
          label: "Operating Income",
          description: "Operating income",
          units: {
            USD: [
              {
                end: "2024-09-28",
                val: 29591000000,
                fy: 2024,
                fp: "Q4",
                form: "10-K",
                filed: "2024-11-01",
                accn: "0000320193-24-000106",
              },
            ],
          },
        },
      },
    },
  };

  it("extracts facts for a specific filing accession number", () => {
    const facts = extractFactsForFiling(
      sampleCompanyFacts as unknown as EdgarCompanyFactsResponse,
      "0000320193-24-000106",
    );
    expect(facts.length).toBe(2);

    const rev = facts.find(
      (f) =>
        f.concept === "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
    expect(rev).toBeDefined();
    expect(rev?.val).toBe("94930000000");
    expect(rev?.fiscalYear).toBe(2024);
    expect(rev?.fiscalPeriod).toBe("Q4");

    const opInc = facts.find((f) => f.concept === "OperatingIncomeLoss");
    expect(opInc).toBeDefined();
    expect(opInc?.val).toBe("29591000000");
  });

  it("finds historical facts by target period end or FY/FP", () => {
    const prior = findHistoricalFact(
      sampleCompanyFacts as unknown as EdgarCompanyFactsResponse,
      ["RevenueFromContractWithCustomerExcludingAssessedTax"],
      { periodEnd: "2023-09-30" },
    );
    expect(prior).not.toBeNull();
    expect(prior?.val).toBe("89498000000");
  });
});

describe("Deterministic Financial Comparator", () => {
  it("formats percentage deltas with correct signs", () => {
    expect(formatDeltaPercent(110, 100)).toBe("+10.0%");
    expect(formatDeltaPercent(90, 100)).toBe("-10.0%");
    expect(formatDeltaPercent(100, 100)).toBe("0.0%");
  });

  it("compares current facts against prior periods and guidance", () => {
    const currentFacts: FactWithMetadata[] = [
      {
        taxonomy: "us-gaap",
        concept: "Revenues",
        label: "Total Revenue",
        unit: "USD",
        val: "105000000",
        periodEnd: "2024-09-30",
        filedDate: "2024-10-25",
        accessionNumber: "0001-24-0001",
        factId: 101,
        secUrl: "https://sec.gov/fact/101",
      },
    ];

    const priorFacts = new Map<string, FactWithMetadata>([
      [
        "Revenues",
        {
          taxonomy: "us-gaap",
          concept: "Revenues",
          label: "Total Revenue",
          unit: "USD",
          val: "100000000",
          periodEnd: "2024-06-30",
          filedDate: "2024-07-25",
          accessionNumber: "0001-24-0002",
          factId: 90,
          secUrl: "https://sec.gov/fact/90",
        },
      ],
    ]);

    const priorYearFacts = new Map<string, FactWithMetadata>([
      [
        "Revenues",
        {
          taxonomy: "us-gaap",
          concept: "Revenues",
          label: "Total Revenue",
          unit: "USD",
          val: "95000000",
          periodEnd: "2023-09-30",
          filedDate: "2023-10-25",
          accessionNumber: "0001-23-0001",
          factId: 50,
          secUrl: "https://sec.gov/fact/50",
        },
      ],
    ]);

    const guidance = new Map([
      [
        "Revenues",
        {
          concept: "Revenues",
          low: "100000000",
          high: "104000000",
        },
      ],
    ]);

    const metrics = compareFinancialMetrics(
      currentFacts,
      priorFacts,
      priorYearFacts,
      guidance,
    );

    expect(metrics.length).toBe(1);
    const m = metrics[0];
    expect(m.reportedValue).toBe("105000000");
    expect(m.reportedCitation.factId).toBe(101);
    expect(m.priorPeriodValue).toBe("100000000");
    expect(m.deltaQoQPercent).toBe("+5.0%");
    expect(m.priorYearValue).toBe("95000000");
    expect(m.deltaYoYPercent).toBe("+10.5%");
    expect(m.guidanceComparison).toBe("above");
  });

  it("gracefully marks guidance as not_provided when absent", () => {
    const currentFacts: FactWithMetadata[] = [
      {
        taxonomy: "us-gaap",
        concept: "NetIncome",
        label: "Net Income",
        unit: "USD",
        val: "25000000",
        periodEnd: "2024-09-30",
        filedDate: "2024-10-25",
        accessionNumber: "0001-24-0001",
        secUrl: "https://sec.gov/fact/102",
      },
    ];

    const metrics = compareFinancialMetrics(
      currentFacts,
      new Map(),
      new Map(),
      new Map(),
    );

    expect(metrics[0].guidanceComparison).toBe("not_provided");
    expect(metrics[0].priorPeriodValue).toBeUndefined();
    expect(metrics[0].deltaQoQPercent).toBeUndefined();
  });
});

describe("Ingest Filings & Superseded Historical Facts", () => {
  it("ingests a 10-Q filing, creates article & financial facts, and updates superseded_by on 10-Q/A amendment", async () => {
    await resetPipeline();

    // 1. Seed Finance industry and SEC source
    const industryId = await seedIndustry("finance");
    const sourceRes = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (?1, 'SEC EDGAR', 'https://data.sec.gov/submissions/', 'sec.gov', 'html', 'active', ?2)
       RETURNING id`,
    )
      .bind(industryId, NOW)
      .first<{ id: number }>();
    expect(sourceRes!.id).toBeGreaterThan(0);

    // 2. Insert tracked company
    const compRes = await env.DB.prepare(
      `INSERT INTO companies (cik, ticker, name, tracked, created_at, updated_at)
       VALUES ('0000320193', 'AAPL', 'Apple Inc.', 1, ?1, ?1)
       RETURNING id`,
    )
      .bind(NOW)
      .first<{ id: number }>();
    const companyId = compRes!.id;

    const mockSubmissions = {
      cik: "0000320193",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      filings: {
        recent: {
          accessionNumber: ["0000320193-24-000001"],
          filingDate: ["2024-08-02"],
          reportDate: ["2024-06-29"],
          acceptanceDateTime: ["2024-08-01T18:00:00.000Z"],
          form: ["10-Q"],
          items: [""],
          primaryDocument: ["aapl-20240629.htm"],
        },
      },
    };

    const mockFacts = {
      cik: 320193,
      entityName: "Apple Inc.",
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            label: "Total Net Sales",
            description: "",
            units: {
              USD: [
                {
                  end: "2024-06-29",
                  val: 85777000000,
                  fy: 2024,
                  fp: "Q3",
                  form: "10-Q",
                  filed: "2024-08-02",
                  accn: "0000320193-24-000001",
                },
              ],
            },
          },
        },
      },
    };

    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("submissions")) {
        return new Response(JSON.stringify(mockSubmissions), { status: 200 });
      }
      if (url.includes("companyfacts")) {
        return new Response(JSON.stringify(mockFacts), { status: 200 });
      }
      return new Response(
        "<html><body>Apple Reports Q3 Results</body></html>",
        { status: 200 },
      );
    });

    const mockEnv = {
      DB: env.DB,
      BODIES: env.BODIES,
      SEC_USER_AGENT: "Personal News test@example.com",
      COLLECT_ENABLED: "true",
    };

    // First ingestion: original 10-Q
    const res1 = await ingestCompanyFilings(
      mockEnv as unknown as PipelineEnv,
      companyId,
      NOW,
      {
        fetch: fakeFetch,
        sleep: async () => {},
      },
    );
    expect(res1.ingestedCount).toBe(1);

    // Verify article created
    const article = await env.DB.prepare(
      "SELECT id, stage, canonical_url FROM articles WHERE industry_id = ?1",
    )
      .bind(industryId)
      .first<{ id: number; stage: string; canonical_url: string }>();
    expect(article).not.toBeNull();
    expect(article?.stage).toBe("body_ready");

    // Verify filing & fact created
    const fact1 = await env.DB.prepare(
      "SELECT id, val, superseded_by FROM financial_facts WHERE company_id = ?1",
    )
      .bind(companyId)
      .first<{ id: number; val: string; superseded_by: number | null }>();
    expect(fact1).not.toBeNull();
    expect(fact1?.val).toBe("85777000000");
    expect(fact1?.superseded_by).toBeNull();

    // Second ingestion: amended 10-Q/A for the same period with restated figure
    const mockAmendedSubmissions = {
      ...mockSubmissions,
      filings: {
        recent: {
          accessionNumber: ["0000320193-24-000002"],
          filingDate: ["2024-09-01"],
          reportDate: ["2024-06-29"],
          acceptanceDateTime: ["2024-09-01T18:00:00.000Z"],
          form: ["10-Q/A"],
          items: [""],
          primaryDocument: ["aapl-20240629a.htm"],
        },
      },
    };

    const mockAmendedFacts = {
      cik: 320193,
      entityName: "Apple Inc.",
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            label: "Total Net Sales",
            description: "",
            units: {
              USD: [
                {
                  end: "2024-06-29",
                  val: 85800000000, // Restated
                  fy: 2024,
                  fp: "Q3",
                  form: "10-Q/A",
                  filed: "2024-09-01",
                  accn: "0000320193-24-000002",
                },
              ],
            },
          },
        },
      },
    };

    const fakeAmendedFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("submissions")) {
        return new Response(JSON.stringify(mockAmendedSubmissions), {
          status: 200,
        });
      }
      if (url.includes("companyfacts")) {
        return new Response(JSON.stringify(mockAmendedFacts), { status: 200 });
      }
      return new Response(
        "<html><body>Apple Reports Restated Q3 Results</body></html>",
        { status: 200 },
      );
    });

    const res2 = await ingestCompanyFilings(
      mockEnv as unknown as PipelineEnv,
      companyId,
      NOW + 1000,
      {
        fetch: fakeAmendedFetch,
        sleep: async () => {},
      },
    );
    expect(res2.ingestedCount).toBe(1);

    // Verify that the original fact's superseded_by now points to the new fact ID!
    const facts = await env.DB.prepare(
      "SELECT id, val, superseded_by FROM financial_facts WHERE company_id = ?1 ORDER BY id ASC",
    )
      .bind(companyId)
      .all<{ id: number; val: string; superseded_by: number | null }>();

    expect(facts.results.length).toBe(2);
    // Old version still exists (M4 acceptance: filing 修订后数字跟着更新，旧版本保留)
    expect(facts.results[0].val).toBe("85777000000");
    expect(facts.results[0].superseded_by).toBe(facts.results[1].id);
    // New version has latest restated figure
    expect(facts.results[1].val).toBe("85800000000");
    expect(facts.results[1].superseded_by).toBeNull();
  });

  it("polls due companies when COLLECT_ENABLED is true and respects limit", async () => {
    await resetPipeline();

    // Insert 3 companies: 2 due, 1 recently polled
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
    const tenMinutesAgo = NOW - 10 * 60 * 1000;

    await env.DB.prepare(
      `INSERT INTO companies (cik, ticker, name, tracked, last_polled_at, created_at, updated_at)
       VALUES
         ('0000320193', 'AAPL', 'Apple Inc.', 1, ?1, ?1, ?1),
         ('0001045810', 'NVDA', 'NVIDIA Corp', 1, ?1, ?1, ?1),
         ('0000789019', 'MSFT', 'Microsoft Corp', 1, ?2, ?2, ?2)`,
    )
      .bind(twoHoursAgo, tenMinutesAgo)
      .run();

    const mockEnv = {
      DB: env.DB,
      COLLECT_ENABLED: "true",
    };

    const res = await pollDueCompanies(
      mockEnv as unknown as PipelineEnv,
      NOW,
      2,
    );
    // Should select the 2 oldest polled companies (AAPL and NVDA)
    expect(res.polledCount).toBe(2);
    expect(res.companyTickers).toEqual(["AAPL", "NVDA"]);

    // If COLLECT_ENABLED is false, polling is skipped entirely
    const disabledEnv = {
      DB: env.DB,
      COLLECT_ENABLED: "false",
    };
    const resDisabled = await pollDueCompanies(
      disabledEnv as unknown as PipelineEnv,
      NOW,
      2,
    );
    expect(resDisabled.polledCount).toBe(0);
    expect(resDisabled.companyTickers).toEqual([]);
  });

  it("handles HTTP 429 with Retry-After backoff", async () => {
    const fakeFetch = vi.fn().mockImplementation(async () => {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    });

    await expect(
      edgarFetch(
        "https://data.sec.gov/submissions/CIK0000320193.json",
        {
          DB: env.DB,
          SEC_USER_AGENT: "Personal News test@example.com",
        },
        NOW,
        { fetch: fakeFetch, sleep: async () => {} },
      ),
    ).rejects.toThrow("SEC EDGAR returned HTTP 429 Too Many Requests");

    const hostRow = await env.DB.prepare(
      "SELECT next_allowed_at FROM fetch_hosts WHERE host = 'data.sec.gov'",
    ).first<{ next_allowed_at: number }>();
    expect(hostRow?.next_allowed_at).toBe(NOW + 120 * 1000);
  });

  it("scans past Form 4 filings to ingest 11th periodic 10-Q filing", async () => {
    await resetPipeline();
    const industryId = await seedIndustry("finance");

    const companyRes = await env.DB.prepare(
      "INSERT INTO companies (cik, ticker, name, tracked, created_at, updated_at) VALUES ('0000320193', 'AAPL', 'Apple Inc.', 1, ?1, ?1) RETURNING id",
    )
      .bind(NOW)
      .first<{ id: number }>();
    const companyId = companyRes!.id;

    // First 10 filings are Form 4, 11th filing is 10-Q
    const accessionNumbers = Array.from(
      { length: 11 },
      (_, i) => `0000320193-24-0000${String(i).padStart(2, "0")}`,
    );
    const forms = [...Array(10).fill("4"), "10-Q"];
    const filingDates = Array(11).fill("2024-08-02");
    const reportDates = Array(11).fill("2024-06-29");
    const acceptanceDateTimes = Array(11).fill("2024-08-02T16:00:00.000Z");
    const items = Array(11).fill("");
    const primaryDocuments = [...Array(10).fill("form4.xml"), "aapl-10q.htm"];

    const mockSubmissions = {
      cik: "0000320193",
      entityType: "operating",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      filings: {
        recent: {
          accessionNumber: accessionNumbers,
          filingDate: filingDates,
          reportDate: reportDates,
          acceptanceDateTime: acceptanceDateTimes,
          form: forms,
          items,
          primaryDocument: primaryDocuments,
        },
      },
    };

    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("submissions")) {
        return new Response(JSON.stringify(mockSubmissions), { status: 200 });
      }
      return new Response("<html><body>Apple 10-Q Document</body></html>", {
        status: 200,
      });
    });

    const mockEnv = {
      DB: env.DB,
      BODIES: env.BODIES,
      SEC_USER_AGENT: "Personal News test@example.com",
      COLLECT_ENABLED: "true",
    };

    const res = await ingestCompanyFilings(
      mockEnv as unknown as PipelineEnv,
      companyId,
      NOW,
      { fetch: fakeFetch, sleep: async () => {} },
    );

    expect(res.ingestedCount).toBe(1);

    const filing = await env.DB.prepare(
      "SELECT accession_number, form FROM filings WHERE company_id = ?1",
    )
      .bind(companyId)
      .first<{ accession_number: string; form: string }>();

    expect(filing?.form).toBe("10-Q");
    expect(filing?.accession_number).toBe(accessionNumbers[10]);

    // Check published_at was parsed from acceptanceDateTime (2024-08-02T16:00:00.000Z)
    const article = await env.DB.prepare(
      "SELECT published_at FROM articles WHERE industry_id = ?1",
    )
      .bind(industryId)
      .first<{ published_at: number }>();
    expect(article?.published_at).toBe(Date.parse("2024-08-02T16:00:00.000Z"));
  });

  it("fetches and appends referenced EX-99.1 exhibit for 8-K Item 2.02 filings", async () => {
    await resetPipeline();
    await seedIndustry("finance");

    const companyRes = await env.DB.prepare(
      "INSERT INTO companies (cik, ticker, name, tracked, created_at, updated_at) VALUES ('0000320193', 'AAPL', 'Apple Inc.', 1, ?1, ?1) RETURNING id",
    )
      .bind(NOW)
      .first<{ id: number }>();
    const companyId = companyRes!.id;

    const mock8KSubmissions = {
      cik: "0000320193",
      entityType: "operating",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      filings: {
        recent: {
          accessionNumber: ["0000320193-24-000050"],
          filingDate: ["2024-08-01"],
          reportDate: ["2024-08-01"],
          acceptanceDateTime: ["2024-08-01T16:30:00.000Z"],
          form: ["8-K"],
          items: ["2.02"],
          primaryDocument: ["aapl-8k.htm"],
        },
      },
    };

    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("submissions")) {
        return new Response(JSON.stringify(mock8KSubmissions), { status: 200 });
      }
      if (url.includes("aapl-8k.htm")) {
        return new Response(
          '<html><body>Item 2.02 Results of Operations. See <a href="ex9901.htm">Exhibit 99.1</a> for details.</body></html>',
          { status: 200 },
        );
      }
      if (url.includes("ex9901.htm")) {
        return new Response(
          "<html><body><h1>Q3 Earnings Release</h1><p>Apple Reports Net Sales of $85.8B.</p></body></html>",
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const mockEnv = {
      DB: env.DB,
      BODIES: env.BODIES,
      SEC_USER_AGENT: "Personal News test@example.com",
      COLLECT_ENABLED: "true",
    };

    const res = await ingestCompanyFilings(
      mockEnv as unknown as PipelineEnv,
      companyId,
      NOW,
      { fetch: fakeFetch, sleep: async () => {} },
    );

    expect(res.ingestedCount).toBe(1);

    const article = await env.DB.prepare(
      "SELECT id, body_sha FROM articles WHERE canonical_url LIKE '%aapl-8k.htm'",
    ).first<{ id: number; body_sha: string }>();

    expect(article).not.toBeNull();
    const bodyObj = await env.BODIES.get(
      `bodies/${article!.id}/${article!.body_sha}.md`,
    );
    const bodyContent = await bodyObj!.text();
    expect(bodyContent).toContain("Exhibit 99.1 (Earnings Press Release)");
    expect(bodyContent).toContain("Apple Reports Net Sales of $85.8B");
  });

  it("marks filing as failed when EX-99.1 fetch fails, and retrying updates article body and avoids duplicate facts", async () => {
    await resetPipeline();
    await seedIndustry("finance");

    const comp = await env.DB.prepare(
      "INSERT INTO companies (cik, ticker, name, tracked, created_at, updated_at) VALUES ('0000320193', 'AAPL', 'Apple Inc.', 1, ?1, ?1) RETURNING id",
    )
      .bind(NOW)
      .first<{ id: number }>();
    const companyId = comp!.id;

    const mock8KSubmissions = {
      cik: "0000320193",
      entityType: "operating",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      filings: {
        recent: {
          accessionNumber: ["0000320193-24-000099"],
          filingDate: ["2024-08-01"],
          reportDate: ["2024-08-01"],
          acceptanceDateTime: ["2024-08-01T16:30:00.000Z"],
          form: ["8-K"],
          items: ["2.02"],
          primaryDocument: ["aapl-8k.htm"],
        },
      },
    };

    let ex99Status = 503;
    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("submissions")) {
        return new Response(JSON.stringify(mock8KSubmissions), { status: 200 });
      }
      if (url.includes("companyfacts")) {
        return new Response(JSON.stringify({ facts: {} }), { status: 200 });
      }
      if (url.includes("aapl-8k.htm")) {
        return new Response(
          '<html><body>Item 2.02. See <a href="ex9901.htm">Exhibit 99.1</a>.</body></html>',
          { status: 200 },
        );
      }
      if (url.includes("ex9901.htm")) {
        if (ex99Status === 503) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response(
          "<html><body><h1>Q3 Earnings Release</h1><p>Net sales $85.8B</p></body></html>",
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const mockEnv = {
      DB: env.DB,
      BODIES: env.BODIES,
      SEC_USER_AGENT: "Personal News test@example.com",
      COLLECT_ENABLED: "true",
    };

    // First attempt: EX-99.1 fails with 503
    const res1 = await ingestCompanyFilings(
      mockEnv as unknown as PipelineEnv,
      companyId,
      NOW,
      { fetch: fakeFetch, sleep: async () => {} },
    );
    expect(res1.ingestedCount).toBe(0);

    const filing1 = await env.DB.prepare(
      "SELECT id, status FROM filings WHERE accession_number = '0000320193-24-000099'",
    ).first<{ id: number; status: string }>();
    expect(filing1?.status).toBe("failed");

    const art1 = await env.DB.prepare(
      "SELECT id, body_sha, stage FROM articles WHERE canonical_url LIKE '%aapl-8k.htm'",
    ).first<{ id: number; body_sha: string; stage: string }>();
    const oldSha = art1!.body_sha;

    // Simulate stage being moved forward (e.g. grouped)
    await env.DB.prepare("UPDATE articles SET stage = 'grouped' WHERE id = ?1")
      .bind(art1!.id)
      .run();

    // Second attempt: EX-99.1 succeeds!
    ex99Status = 200;
    const res2 = await ingestCompanyFilings(
      mockEnv as unknown as PipelineEnv,
      companyId,
      NOW + 1000,
      { fetch: fakeFetch, sleep: async () => {} },
    );
    expect(res2.ingestedCount).toBe(1);

    const filing2 = await env.DB.prepare(
      "SELECT status FROM filings WHERE id = ?1",
    )
      .bind(filing1!.id)
      .first<{ status: string }>();
    expect(filing2?.status).toBe("processed");

    // Check that article body_sha was updated and stage was reset to body_ready!
    const art2 = await env.DB.prepare(
      "SELECT body_sha, stage, requeue_count FROM articles WHERE id = ?1",
    )
      .bind(art1!.id)
      .first<{ body_sha: string; stage: string; requeue_count: number }>();
    expect(art2?.body_sha).not.toBe(oldSha);
    expect(art2?.stage).toBe("body_ready");
    expect(art2?.requeue_count).toBe(0);
  });
});
