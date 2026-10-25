import type { EdgarCompanyFactsResponse, EdgarFactUnitItem } from "./client";

export interface NormalizedFinancialFact {
  taxonomy: string;
  concept: string;
  label: string;
  unit: string;
  val: string;
  periodStart?: string;
  periodEnd: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
  frame?: string;
  filedDate: string;
  accessionNumber: string;
}

/** Standard core financial concepts to extract from US-GAAP company facts. */
export const CORE_GAAP_CONCEPTS: Record<
  string,
  { label: string; aliases: string[] }
> = {
  Revenues: {
    label: "Total Revenue",
    aliases: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "SalesRevenueNet",
      "Revenues",
    ],
  },
  OperatingIncome: {
    label: "Operating Income",
    aliases: ["OperatingIncomeLoss"],
  },
  NetIncome: {
    label: "Net Income",
    aliases: ["NetIncomeLoss"],
  },
  DilutedEPS: {
    label: "Diluted EPS",
    aliases: ["EarningsPerShareDiluted", "EarningsPerShareBasic"],
  },
  GrossProfit: {
    label: "Gross Profit",
    aliases: ["GrossProfit"],
  },
  ResearchAndDevelopment: {
    label: "R&D Expense",
    aliases: ["ResearchAndDevelopmentExpense"],
  },
};

export interface FilingFactFilterMeta {
  reportDate?: string;
  form?: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
}

/** Extracts and normalizes facts for a specific filing accession number from company facts. */
export function extractFactsForFiling(
  companyFacts: EdgarCompanyFactsResponse,
  accessionNumber: string,
  filingMeta?: FilingFactFilterMeta,
): NormalizedFinancialFact[] {
  const results: NormalizedFinancialFact[] = [];
  const gaapFacts = companyFacts.facts["us-gaap"] ?? {};

  for (const [standardKey, config] of Object.entries(CORE_GAAP_CONCEPTS)) {
    let matchedFactItem: EdgarFactUnitItem | null = null;
    let matchedConcept = standardKey;
    let matchedUnit = "USD";
    let matchedLabel = config.label;

    for (const alias of config.aliases) {
      const conceptData = gaapFacts[alias];
      if (!conceptData) continue;

      for (const [unit, items] of Object.entries(conceptData.units)) {
        const candidateItems = items.filter((i) => i.accn === accessionNumber);
        if (candidateItems.length === 0) continue;

        if (candidateItems.length === 1) {
          matchedFactItem = candidateItems[0];
        } else {
          // If multiple items under the same accession (e.g. 3-mo vs 9-mo, or prior year comparative numbers in same 10-Q)
          // 1. Prefer matching reportDate
          let filtered = candidateItems;
          if (filingMeta?.reportDate) {
            const reportDateMatches = candidateItems.filter(
              (i) => i.end === filingMeta.reportDate,
            );
            if (reportDateMatches.length > 0) {
              filtered = reportDateMatches;
            }
          }

          // 2. If 10-Q, 10-Q/A or quarterly period, prefer single-quarter duration (~60 to 110 days) over YTD
          const isQuarterly =
            filingMeta?.form === "10-Q" ||
            filingMeta?.form === "10-Q/A" ||
            (filingMeta?.fiscalPeriod &&
              ["Q1", "Q2", "Q3", "Q4"].includes(filingMeta.fiscalPeriod));
          if (isQuarterly) {
            const quarterlyItems = filtered.filter((i) => {
              if (!i.start || !i.end) return true; // point-in-time concept (balance sheet)
              const startMs = Date.parse(i.start);
              const endMs = Date.parse(i.end);
              if (isNaN(startMs) || isNaN(endMs)) return true;
              const days = (endMs - startMs) / (1000 * 3600 * 24);
              return days >= 55 && days <= 120;
            });
            if (quarterlyItems.length > 0) {
              filtered = quarterlyItems;
            }
          }

          // 3. Prefer matching fiscal year / period if available
          if (filingMeta?.fiscalYear) {
            const fyMatches = filtered.filter(
              (i) => i.fy === filingMeta.fiscalYear,
            );
            if (fyMatches.length > 0) filtered = fyMatches;
          }
          if (filingMeta?.fiscalPeriod) {
            const fpMatches = filtered.filter(
              (i) => i.fp === filingMeta.fiscalPeriod,
            );
            if (fpMatches.length > 0) filtered = fpMatches;
          }

          matchedFactItem = filtered[0] || candidateItems[0];
        }

        if (matchedFactItem) {
          matchedConcept = alias;
          matchedUnit = unit;
          matchedLabel = conceptData.label || config.label;
          break;
        }
      }
      if (matchedFactItem) break;
    }

    if (matchedFactItem) {
      results.push({
        taxonomy: "us-gaap",
        concept: matchedConcept,
        label: matchedLabel,
        unit: matchedUnit,
        val: String(matchedFactItem.val),
        periodStart: matchedFactItem.start,
        periodEnd: matchedFactItem.end,
        fiscalYear: matchedFactItem.fy,
        fiscalPeriod: matchedFactItem.fp,
        frame: matchedFactItem.frame,
        filedDate: matchedFactItem.filed,
        accessionNumber: matchedFactItem.accn,
      });
    }
  }

  return results;
}

/** Finds a specific concept fact for prior periods (e.g. prior quarter or prior year) */
export function findHistoricalFact(
  companyFacts: EdgarCompanyFactsResponse,
  conceptAliasList: string[],
  target: {
    periodEnd?: string;
    fiscalYear?: number;
    fiscalPeriod?: string;
    form?: string;
  },
): { val: string; end: string; accn: string; unit: string } | null {
  const gaapFacts = companyFacts.facts["us-gaap"] ?? {};

  for (const alias of conceptAliasList) {
    const conceptData = gaapFacts[alias];
    if (!conceptData) continue;

    for (const [unit, items] of Object.entries(conceptData.units)) {
      // Find matching items by period or FY/FP
      const match = items.find((item) => {
        if (target.periodEnd && item.end !== target.periodEnd) return false;
        if (target.fiscalYear && item.fy !== target.fiscalYear) return false;
        if (target.fiscalPeriod && item.fp !== target.fiscalPeriod)
          return false;
        if (target.form && item.form !== target.form) return false;
        return true;
      });

      if (match) {
        return {
          val: String(match.val),
          end: match.end,
          accn: match.accn,
          unit,
        };
      }
    }
  }

  return null;
}
