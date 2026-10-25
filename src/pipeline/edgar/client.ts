import type { PipelineEnv } from "../messages";
import { claimHostSlot } from "../body/robots";

export interface EdgarClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface EdgarSubmissionsResponse {
  cik: string;
  entityType: string;
  sic: string;
  sicDescription: string;
  name: string;
  tickers: string[];
  exchanges: string[];
  ein: string;
  description: string;
  category: string;
  fiscalYearEnd: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      acceptanceDateTime: string[];
      act: string[];
      form: string[];
      fileNumber: string[];
      filmNumber: string[];
      items: string[];
      size: number[];
      isXBRL: number[];
      isInlineXBRL: number[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
    files?: Array<{
      name: string;
      filingCount: number;
      filingFrom: string;
      filingTo: string;
    }>;
  };
}

export interface EdgarCompanyFactsResponse {
  cik: number;
  entityName: string;
  facts: {
    "us-gaap"?: Record<string, EdgarConceptFacts>;
    dei?: Record<string, EdgarConceptFacts>;
    [taxonomy: string]: Record<string, EdgarConceptFacts> | undefined;
  };
}

export interface EdgarConceptFacts {
  label: string;
  description: string;
  units: Record<string, EdgarFactUnitItem[]>;
}

export interface EdgarFactUnitItem {
  end: string;
  val: number | string;
  fy?: number;
  fp?: string;
  form?: string;
  filed: string;
  frame?: string;
  accn: string;
  start?: string;
}

/** Formats a CIK number to 10-digit zero-padded string required by SEC EDGAR APIs. */
export function formatCik10(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, "");
  return digits.padStart(10, "0");
}

/** Ensures host exists in fetch_hosts table for claimHostSlot. */
async function ensureHostRow(
  db: D1Database,
  host: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fetch_hosts (host, robots_status, robots_fetched_at)
       VALUES (?1, 200, ?2)
       ON CONFLICT(host) DO NOTHING`,
    )
    .bind(host, now)
    .run();
}

/** Executes an SEC EDGAR fetch request with SEC_USER_AGENT and host rate slot protection. */
export async function edgarFetch(
  url: string,
  env: Pick<PipelineEnv, "DB" | "SEC_USER_AGENT">,
  now: number,
  deps?: EdgarClientDeps,
): Promise<Response> {
  const fetchFn = deps?.fetch ?? fetch;
  const sleepFn =
    deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const secUserAgent = env.SEC_USER_AGENT?.trim();
  if (!secUserAgent) {
    throw new Error(
      "SEC_USER_AGENT is not configured. SEC EDGAR API strictly requires a valid User-Agent header.",
    );
  }

  const parsedUrl = new URL(url);
  const host = parsedUrl.host;

  // Rate limiting via fetch_hosts (delaySec: 0.3s for SEC EDGAR <= 10 req/s constraint)
  await ensureHostRow(env.DB, host, now);
  const maxRetries = 10;
  let attempts = 0;
  let currentNow = now;
  while (attempts < maxRetries) {
    const slot = await claimHostSlot(env, host, 1, currentNow);
    if (slot.claimed) {
      break;
    }
    const waitMs = Math.max(100, (slot.waitSec || 1) * 1000);
    await sleepFn(waitMs);
    currentNow += waitMs;
    attempts++;
  }

  const response = await fetchFn(url, {
    headers: {
      "User-Agent": secUserAgent,
      Accept: "application/json, text/html, application/xhtml+xml, */*",
    },
  });

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    let backoffSec = 600;
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      if (!isNaN(parsed) && parsed > 0) {
        backoffSec = parsed;
      }
    }
    await env.DB.prepare(
      `UPDATE fetch_hosts SET next_allowed_at = ?2 WHERE host = ?1`,
    )
      .bind(host, now + backoffSec * 1000)
      .run();
    throw new Error(
      `SEC EDGAR returned HTTP 429 Too Many Requests. Backing off host ${host} for ${backoffSec}s.`,
    );
  }

  return response;
}

/** Fetches SEC submissions metadata for a given CIK. */
export async function fetchSubmissions(
  cik: string | number,
  env: Pick<PipelineEnv, "DB" | "SEC_USER_AGENT">,
  now: number,
  deps?: EdgarClientDeps,
): Promise<EdgarSubmissionsResponse> {
  const cik10 = formatCik10(cik);
  const url = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  const res = await edgarFetch(url, env, now, deps);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch SEC submissions for CIK ${cik10}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as EdgarSubmissionsResponse;
}

/** Fetches SEC XBRL company facts for a given CIK. */
export async function fetchCompanyFacts(
  cik: string | number,
  env: Pick<PipelineEnv, "DB" | "SEC_USER_AGENT">,
  now: number,
  deps?: EdgarClientDeps,
): Promise<EdgarCompanyFactsResponse> {
  const cik10 = formatCik10(cik);
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;
  const res = await edgarFetch(url, env, now, deps);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch SEC company facts for CIK ${cik10}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as EdgarCompanyFactsResponse;
}

/** Fetches raw filing document or exhibit HTML/text. */
export async function fetchFilingDocument(
  url: string,
  env: Pick<PipelineEnv, "DB" | "SEC_USER_AGENT">,
  now: number,
  deps?: EdgarClientDeps,
): Promise<string> {
  const res = await edgarFetch(url, env, now, deps);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch SEC document at ${url}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  return await res.text();
}
