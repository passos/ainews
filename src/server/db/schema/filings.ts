import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { articles } from "./articles";
import { companies } from "./companies";

export const filings = sqliteTable(
  "filings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    /** SEC accession number, e.g. "0000320193-24-000106". */
    accessionNumber: text("accession_number").notNull(),
    /** SEC Form type: "10-K", "10-Q", "8-K", "10-K/A", "10-Q/A", etc. */
    form: text("form").notNull(),
    /** Filing submission date in YYYY-MM-DD format. */
    filingDate: text("filing_date").notNull(),
    /** Fiscal period end date in YYYY-MM-DD format. */
    reportDate: text("report_date"),
    /** Acceptance timestamp from SEC submission header. */
    acceptanceDateTime: text("acceptance_date_time"),
    /** Comma-separated list of 8-K items if applicable, e.g. "2.02,9.01". */
    items: text("items"),
    /** Primary document filename, e.g. "aapl-20240928.htm". */
    primaryDocument: text("primary_document"),
    /** Full SEC EDGAR document URL. */
    secUrl: text("sec_url").notNull(),
    /** Linked article in articles table for editorial review & event grouping. */
    articleId: integer("article_id").references(() => articles.id),
    /** Fiscal year as integer, e.g. 2024. */
    fiscalYear: integer("fiscal_year"),
    /** Fiscal period: "Q1", "Q2", "Q3", "FY". */
    fiscalPeriod: text("fiscal_period"),
    /** Processing status: "pending", "processed", "failed". */
    status: text("status").notNull().default("processed"),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("filings_accession_unique").on(t.accessionNumber),
    index("filings_company_date_idx").on(t.companyId, t.filingDate),
    index("filings_article_id_idx").on(t.articleId),
  ],
);
