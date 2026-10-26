// #102: artifacts/build.ts reads only approved articles of the event.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { generateEventArtifacts } from "../../src/pipeline/artifacts/build";
import type { PipelineEnv } from "../../src/pipeline/messages";
import type { ModelTransport } from "../../src/providers/transport";
import {
  seedArticleInEvent,
  seedEvent,
  seedSection,
} from "./approved-behaviour-helpers";

const testEnv: PipelineEnv = { ...env, MODEL_CALLS_ENABLED: "true" };

describe("generateEventArtifacts approved condition (#102)", () => {
  it("builds the prompt from the approved article only", async () => {
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
       VALUES ('2026-10-24', 'gateway', 10000000, 0, 0)
       ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
    ).run();
    const section = await seedSection();
    const eventId = await seedEvent(section.industryId);
    await seedArticleInEvent(eventId, section, {
      kind: "approved",
      title: "Zebra Approved Headline",
    });
    await seedArticleInEvent(eventId, section, {
      kind: "none",
      title: "Quokka Unreviewed Headline",
    });
    await seedArticleInEvent(eventId, section, {
      kind: "stale",
      title: "Narwhal Stale Headline",
    });

    const prompts: string[] = [];
    const transport: ModelTransport = {
      run: async (_model, input) => {
        prompts.push(JSON.stringify(input));
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      whatHappened: "A.",
                      whatIsNew: "B.",
                      whatEvidenceExists: "C.",
                      whatToWatchNext: "D.",
                    }),
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

    const res = await generateEventArtifacts(testEnv, eventId, 1000, {
      transport,
    });

    expect(res.status).toBe("generated");
    const all = prompts.join("\n");
    expect(all).toContain("Zebra Approved Headline");
    expect(all).not.toContain("Quokka Unreviewed Headline");
    expect(all).not.toContain("Narwhal Stale Headline");
  });

  it("earnings_decoder prior facts come from approved filings only", async () => {
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
       VALUES ('2026-10-24', 'gateway', 10000000, 0, 0)
       ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
    ).run();
    let fin = await env.DB.prepare(
      "SELECT id FROM industries WHERE slug = 'finance'",
    ).first<{ id: number }>();
    if (!fin) {
      fin = await env.DB.prepare(
        "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('finance', 'Finance', 'review', 1000) RETURNING id",
      ).first<{ id: number }>();
    }
    const section = {
      industryId: fin!.id,
      tag: crypto.randomUUID().slice(0, 8),
    };
    const cik = String(Math.floor(Math.random() * 1e9)).padStart(10, "9");
    const comp = await env.DB.prepare(
      "INSERT INTO companies (cik, ticker, name, tracked, created_at, updated_at) VALUES (?1, ?1, 'Appr102 Corp', 1, 1000, 1000) RETURNING id",
    )
      .bind(cik)
      .first<{ id: number }>();

    // One filing with one Revenues fact.
    const seedFiling = async (
      articleId: number,
      accn: string,
      val: string,
      periodEnd: string,
      fiscalYear: number,
      fiscalPeriod: string,
    ) => {
      const filing = await env.DB.prepare(
        `INSERT INTO filings (company_id, accession_number, form, filing_date, report_date, fiscal_year, fiscal_period, sec_url, article_id, status, created_at)
         VALUES (?1, ?2, '10-Q', ?3, ?3, ?4, ?5, 'https://sec.gov/appr102', ?6, 'processed', 1000) RETURNING id`,
      )
        .bind(comp!.id, accn, periodEnd, fiscalYear, fiscalPeriod, articleId)
        .first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO financial_facts (company_id, filing_id, accession_number, taxonomy, concept, unit, val, period_end, fiscal_year, fiscal_period, filed_date, sec_url, created_at)
         VALUES (?1, ?2, ?3, 'us-gaap', 'Revenues', 'USD', ?4, ?5, ?6, ?7, ?5, 'https://sec.gov/appr102/fact', 1000)`,
      )
        .bind(
          comp!.id,
          filing!.id,
          accn,
          val,
          periodEnd,
          fiscalYear,
          fiscalPeriod,
        )
        .run();
    };

    const eventId = await seedEvent(fin!.id);
    const cur = await seedArticleInEvent(eventId, section, {
      kind: "approved",
      title: "Appr102 Current Filing",
    });
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, selected, created_at)
       VALUES (?1, 'pv1', '{}', 'sec_filing', '["sec_filing"]', 90, 1, 1000)`,
    )
      .bind(cur.id)
      .run();
    await seedFiling(
      cur.id,
      `${cik}-cur`,
      "500000000",
      "2024-09-30",
      2024,
      "Q3",
    );

    // Prior quarter (Q2 2024): the rejected filing has the newest
    // period_end, so it is picked first unless it is filtered out.
    const rejected = await seedArticleInEvent(null, section, {
      kind: "rejected",
      title: "Appr102 Rejected Prior",
    });
    await seedFiling(
      rejected.id,
      `${cik}-rej`,
      "111111111",
      "2024-06-30",
      2024,
      "Q2",
    );
    const control = await seedArticleInEvent(null, section, {
      kind: "approved",
      title: "Appr102 Approved Prior",
    });
    await seedFiling(
      control.id,
      `${cik}-ctl`,
      "333333333",
      "2024-06-29",
      2024,
      "Q2",
    );
    // Prior year (Q3 2023): the only candidate is approved for an old body.
    const stale = await seedArticleInEvent(null, section, {
      kind: "stale",
      title: "Appr102 Stale Prior",
    });
    await seedFiling(
      stale.id,
      `${cik}-stl`,
      "222222222",
      "2023-09-30",
      2023,
      "Q3",
    );

    const prompts: string[] = [];
    const transport: ModelTransport = {
      run: async (_model, input) => {
        prompts.push(JSON.stringify(input));
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      executiveSummary: "E.",
                      keyDrivers: ["F"],
                      forwardGuidance: ["G"],
                    }),
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
    const res = await generateEventArtifacts(testEnv, eventId, 1000, {
      transport,
    });

    expect(res.status).toBe("generated");
    const decoder = prompts.filter((p) => p.includes("PriorQuarter="));
    expect(decoder.length).toBeGreaterThan(0);
    const all = decoder.join("\n");
    expect(all).toContain("Reported=500000000");
    expect(all).toContain("PriorQuarter=333333333");
    expect(all).not.toContain("111111111");
    expect(all).not.toContain("222222222");
    expect(all).not.toContain("PriorYear=");
  });
});
