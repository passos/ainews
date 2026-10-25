import { isEnabled } from "../../lib/flags";
import type { PipelineEnv } from "../messages";
import type { EdgarClientDeps } from "./client";
import {
  fetchCompanyFacts,
  fetchFilingDocument,
  fetchSubmissions,
  formatCik10,
} from "./client";
import { extractFactsForFiling } from "./xbrl";

export interface EdgarIngestDeps extends EdgarClientDeps {
  toMarkdown?: (html: string, baseUrl: string) => Promise<string>;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Basic fallback HTML to markdown stripper if AI toMarkdown is unavailable */
function simpleHtmlToMarkdown(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n\n### $1\n\n")
    .replace(/<p[^>]*>(.*?)<\/p>/gi, "\n\n$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, "$1\n")
    .replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, " | $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}

/** Checks for new EDGAR filings of tracked companies, ingests facts and creates reviewable articles. */
export async function ingestCompanyFilings(
  env: PipelineEnv,
  companyId: number,
  now: number,
  deps?: EdgarIngestDeps,
): Promise<{ ingestedCount: number }> {
  // Safety valve: Respect COLLECT_ENABLED
  if (!isEnabled(env, "COLLECT_ENABLED")) {
    return { ingestedCount: 0 };
  }

  // 1. Get company details
  const company = await env.DB.prepare(
    "SELECT id, cik, ticker, name, tracked FROM companies WHERE id = ?1",
  )
    .bind(companyId)
    .first<{
      id: number;
      cik: string;
      ticker: string;
      name: string;
      tracked: number;
    }>();

  if (!company || company.tracked !== 1) {
    return { ingestedCount: 0 };
  }

  // 2. Get Finance industry ID and SEC EDGAR system source ID
  const financeIndustry = await env.DB.prepare(
    "SELECT id FROM industries WHERE slug = 'finance'",
  ).first<{ id: number }>();
  if (!financeIndustry) {
    console.error("Finance industry not found in database.");
    return { ingestedCount: 0 };
  }

  let edgarSource = await env.DB.prepare(
    "SELECT id FROM sources WHERE industry_id = ?1 AND feed_url LIKE '%data.sec.gov%' LIMIT 1",
  )
    .bind(financeIndustry.id)
    .first<{ id: number }>();

  if (!edgarSource) {
    edgarSource = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (?1, 'SEC EDGAR System Source', 'https://data.sec.gov/submissions/', 'sec.gov', 'html', 'active', ?2)
       RETURNING id`,
    )
      .bind(financeIndustry.id, now)
      .first<{ id: number }>();
  }

  if (!edgarSource) {
    console.error("SEC EDGAR system source could not be initialized.");
    return { ingestedCount: 0 };
  }

  // 3. Fetch submissions
  const cik10 = formatCik10(company.cik);
  let submissions;
  try {
    submissions = await fetchSubmissions(cik10, env, now, deps);
  } catch (err) {
    console.error(
      "Failed to fetch submissions for company",
      company.ticker,
      err,
    );
    return { ingestedCount: 0 };
  }

  const recent = submissions.filings.recent;
  if (!recent || !recent.accessionNumber) {
    return { ingestedCount: 0 };
  }

  let ingestedCount = 0;
  let companyFactsCache: Awaited<ReturnType<typeof fetchCompanyFacts>> | null =
    null;

  // Process recent filings (search for 10-K, 10-Q, 8-K Item 2.02, 10-K/A, 10-Q/A)
  // Limit to recent 10 filings to avoid long running operations
  const count = Math.min(recent.accessionNumber.length, 10);
  const rawCik = String(parseInt(company.cik, 10));

  for (let i = 0; i < count; i++) {
    const accn = recent.accessionNumber[i];
    const form = recent.form[i];
    const filingDate = recent.filingDate[i];
    const reportDate = recent.reportDate[i];
    const items = recent.items[i] || "";
    const primaryDoc = recent.primaryDocument[i];

    // Filter relevant financial reporting filings: 10-K, 10-Q, 10-K/A, 10-Q/A, or 8-K with Item 2.02
    const isPeriodic =
      form === "10-K" ||
      form === "10-Q" ||
      form === "10-K/A" ||
      form === "10-Q/A";
    const isEarnings8K = form === "8-K" && items.includes("2.02");

    if (!isPeriodic && !isEarnings8K) {
      continue;
    }

    // Check if filing already exists
    const existingFiling = await env.DB.prepare(
      "SELECT id FROM filings WHERE accession_number = ?1",
    )
      .bind(accn)
      .first<{ id: number }>();

    if (existingFiling) {
      continue;
    }

    // Build SEC URL: https://www.sec.gov/Archives/edgar/data/{rawCik}/{accnStripped}/{primaryDoc}
    const accnStripped = accn.replace(/-/g, "");
    const secDocUrl = `https://www.sec.gov/Archives/edgar/data/${rawCik}/${accnStripped}/${primaryDoc}`;

    // Fetch filing document text
    let bodyText: string;
    try {
      const docHtml = await fetchFilingDocument(secDocUrl, env, now, deps);
      if (deps?.toMarkdown) {
        bodyText = await deps.toMarkdown(docHtml, secDocUrl);
      } else {
        bodyText = simpleHtmlToMarkdown(docHtml);
      }
    } catch (e) {
      console.warn("Failed to fetch document for filing", accn, secDocUrl, e);
      bodyText = `SEC ${form} filing submitted by ${company.name} (${company.ticker}) on ${filingDate}.\nAccession: ${accn}\nSEC URL: ${secDocUrl}`;
    }

    // Truncate to 1.5MB max
    if (bodyText.length > 1_500_000) {
      bodyText = bodyText.slice(0, 1_500_000) + "\n\n[Truncated...]";
    }

    const bodySha = await sha256Hex(bodyText);

    // Fetch XBRL company facts if not cached
    if (!companyFactsCache) {
      try {
        companyFactsCache = await fetchCompanyFacts(cik10, env, now, deps);
      } catch (err) {
        console.warn("Failed to fetch company facts for CIK", cik10, err);
      }
    }

    const title = `${company.ticker} ${form}: ${company.name} Reports Financial Results (${filingDate})`;
    const summary = `${company.name} (${company.ticker}) filed ${form} with the SEC on ${filingDate}. Report date: ${reportDate || filingDate}.`;

    // 1. Create article record in DB
    const articleInsert = await env.DB.prepare(
      `INSERT INTO articles (
        source_id, industry_id, canonical_url, url, title, summary,
        published_raw, published_at, fetched_at, stage, stage_updated_at,
        body_sha, body_kind, body_fetched_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, 'body_ready', ?10,
        ?11, 'full', ?12
      )
      ON CONFLICT(canonical_url) DO UPDATE SET stage = stage
      RETURNING id`,
    )
      .bind(
        edgarSource.id,
        financeIndustry.id,
        secDocUrl,
        secDocUrl,
        title,
        summary,
        filingDate,
        now,
        now,
        now,
        bodySha,
        now,
      )
      .first<{ id: number }>();

    const articleId = articleInsert?.id;
    if (!articleId) {
      continue;
    }

    // Save body to R2
    const r2Key = `bodies/${articleId}/${bodySha}.md`;
    await env.BODIES.put(r2Key, bodyText, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: {
        url: secDocUrl,
        fetchedAt: String(now),
        accessionNumber: accn,
      },
    });

    // 2. Create filing record
    const filingInsert = await env.DB.prepare(
      `INSERT INTO filings (
        company_id, accession_number, form, filing_date, report_date,
        items, primary_document, sec_url, article_id, status, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, 'processed', ?10
      ) RETURNING id`,
    )
      .bind(
        company.id,
        accn,
        form,
        filingDate,
        reportDate,
        items,
        primaryDoc,
        secDocUrl,
        articleId,
        now,
      )
      .first<{ id: number }>();

    const filingId = filingInsert?.id;

    // 3. Extract and store XBRL facts if available
    if (filingId && companyFactsCache) {
      const normalizedFacts = extractFactsForFiling(companyFactsCache, accn);
      const isAmended = form.includes("/A");

      for (const fact of normalizedFacts) {
        const factInsert = await env.DB.prepare(
          `INSERT INTO financial_facts (
            company_id, filing_id, accession_number, taxonomy, concept,
            unit, val, period_start, period_end, fiscal_year, fiscal_period,
            frame, filed_date, sec_url, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15
          ) RETURNING id`,
        )
          .bind(
            company.id,
            filingId,
            accn,
            fact.taxonomy,
            fact.concept,
            fact.unit,
            fact.val,
            fact.periodStart ?? null,
            fact.periodEnd,
            fact.fiscalYear ?? null,
            fact.fiscalPeriod ?? null,
            fact.frame ?? null,
            fact.filedDate,
            secDocUrl,
            now,
          )
          .first<{ id: number }>();

        // If this is an amended filing, update superseded_by on earlier facts for the same concept and period
        if (isAmended && factInsert?.id) {
          await env.DB.prepare(
            `UPDATE financial_facts
             SET superseded_by = ?1
             WHERE company_id = ?2
               AND concept = ?3
               AND period_end = ?4
               AND id != ?1
               AND superseded_by IS NULL`,
          )
            .bind(factInsert.id, company.id, fact.concept, fact.periodEnd)
            .run();
        }
      }
    }

    ingestedCount++;
  }

  // Update company lastPolledAt
  await env.DB.prepare(
    "UPDATE companies SET last_polled_at = ?2, updated_at = ?2 WHERE id = ?1",
  )
    .bind(company.id, now)
    .run();

  return { ingestedCount };
}
