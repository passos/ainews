import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { companies } from "./companies";
import { filings } from "./filings";

export const financialFacts = sqliteTable(
  "financial_facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    filingId: integer("filing_id")
      .notNull()
      .references(() => filings.id),
    /** Accession number of the filing that reported this fact. */
    accessionNumber: text("accession_number").notNull(),
    /** Taxonomy identifier, e.g. "us-gaap" or "dei". */
    taxonomy: text("taxonomy").notNull(),
    /** XBRL concept tag, e.g. "Revenues", "NetIncomeLoss", "EarningsPerShareDiluted". */
    concept: text("concept").notNull(),
    /** Currency or unit, e.g. "USD", "shares", "pure". */
    unit: text("unit").notNull(),
    /** String representation of number to avoid IEEE 754 precision issues. */
    val: text("val").notNull(),
    /** Period start date (YYYY-MM-DD) for duration facts, null for instant facts. */
    periodStart: text("period_start"),
    /** Period end date (YYYY-MM-DD). */
    periodEnd: text("period_end").notNull(),
    /** Fiscal year if known. */
    fiscalYear: integer("fiscal_year"),
    /** Fiscal period: "Q1", "Q2", "Q3", "FY". */
    fiscalPeriod: text("fiscal_period"),
    /** Standardized CY frame if assigned by SEC, e.g. "CY2024Q3". */
    frame: text("frame"),
    /** Date filed with the SEC (YYYY-MM-DD). */
    filedDate: text("filed_date").notNull(),
    /** SEC EDGAR document or interactive data URL. */
    secUrl: text("sec_url").notNull(),
    /** ID of the restating/superseding fact when amended, null if latest active fact. */
    supersededBy: integer("superseded_by").references(
      (): AnySQLiteColumn => financialFacts.id,
    ),
    /** Epoch milliseconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("financial_facts_lookup_idx").on(
      t.companyId,
      t.concept,
      t.fiscalYear,
      t.fiscalPeriod,
    ),
    index("financial_facts_superseded_idx").on(t.supersededBy),
    index("financial_facts_filing_id_idx").on(t.filingId),
    index("financial_facts_accession_idx").on(t.accessionNumber),
  ],
);
