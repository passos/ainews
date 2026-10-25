import { isEnabled } from "../../lib/flags";
import type { PipelineEnv } from "../messages";
import { ingestCompanyFilings } from "./ingest";

/** Selects tracked companies that are due for polling filings, ordered by oldest polled first. */
export async function pollDueCompanies(
  env: PipelineEnv,
  now: number,
  limit = 2,
): Promise<{ polledCount: number; companyTickers: string[] }> {
  if (!isEnabled(env, "COLLECT_ENABLED")) {
    return { polledCount: 0, companyTickers: [] };
  }

  // 1 hour polling interval per company
  const oneHourAgo = now - 60 * 60 * 1000;

  const rows = await env.DB.prepare(
    `SELECT id, ticker FROM companies
     WHERE tracked = 1
       AND (last_polled_at IS NULL OR last_polled_at <= ?1)
     ORDER BY COALESCE(last_polled_at, 0) ASC
     LIMIT ?2`,
  )
    .bind(oneHourAgo, limit)
    .all<{ id: number; ticker: string }>();

  const companies = rows.results || [];
  const tickers: string[] = [];

  for (const c of companies) {
    try {
      await ingestCompanyFilings(env, c.id, now);
      tickers.push(c.ticker);
    } catch (e) {
      console.error("Error polling filings for company", c.ticker, e);
    }
  }

  return { polledCount: tickers.length, companyTickers: tickers };
}
