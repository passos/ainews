import type { EarningsMetric, FactCitation } from "../../lib/artifacts/types";
import type { NormalizedFinancialFact } from "./xbrl";

export interface GuidanceInfo {
  concept: string;
  low?: string;
  high?: string;
  midpoint?: string;
  quote?: string;
  secUrl?: string;
}

export interface FactWithMetadata extends NormalizedFinancialFact {
  factId?: number;
  secUrl: string;
  quote?: string;
}

/** Formats a numeric percentage delta as "+12.4%" or "-3.2%". */
export function formatDeltaPercent(
  currentVal: number,
  baselineVal: number,
): string | undefined {
  if (baselineVal === 0 || isNaN(currentVal) || isNaN(baselineVal)) {
    return undefined;
  }
  const delta = ((currentVal - baselineVal) / Math.abs(baselineVal)) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

/** Pure deterministic comparison between reported facts and prior periods / guidance. */
export function compareFinancialMetrics(
  currentFacts: FactWithMetadata[],
  priorPeriodFacts: Map<string, FactWithMetadata>,
  priorYearFacts: Map<string, FactWithMetadata>,
  guidances: Map<string, GuidanceInfo> = new Map(),
): EarningsMetric[] {
  const metrics: EarningsMetric[] = [];

  for (const fact of currentFacts) {
    const conceptKey = fact.concept;
    const currentNum = parseFloat(fact.val);

    const reportedCitation: FactCitation = {
      factId: fact.factId,
      secUrl: fact.secUrl,
      quote: fact.quote,
      periodEnd: fact.periodEnd,
    };

    // Prior quarter / QoQ
    const priorFact = priorPeriodFacts.get(conceptKey);
    let priorPeriodValue: string | undefined;
    let priorPeriodCitation: FactCitation | undefined;
    let deltaQoQPercent: string | undefined;

    if (priorFact) {
      priorPeriodValue = priorFact.val;
      priorPeriodCitation = {
        factId: priorFact.factId,
        secUrl: priorFact.secUrl,
        quote: priorFact.quote,
        periodEnd: priorFact.periodEnd,
      };
      const priorNum = parseFloat(priorFact.val);
      deltaQoQPercent = formatDeltaPercent(currentNum, priorNum);
    }

    // Prior year / YoY
    const priorYearFact = priorYearFacts.get(conceptKey);
    let priorYearValue: string | undefined;
    let priorYearCitation: FactCitation | undefined;
    let deltaYoYPercent: string | undefined;

    if (priorYearFact) {
      priorYearValue = priorYearFact.val;
      priorYearCitation = {
        factId: priorYearFact.factId,
        secUrl: priorYearFact.secUrl,
        quote: priorYearFact.quote,
        periodEnd: priorYearFact.periodEnd,
      };
      const priorYearNum = parseFloat(priorYearFact.val);
      deltaYoYPercent = formatDeltaPercent(currentNum, priorYearNum);
    }

    // Guidance comparison
    const guidance = guidances.get(conceptKey);
    let guidanceComparison: "above" | "within" | "below" | "not_provided" =
      "not_provided";

    let guidanceRange: EarningsMetric["guidanceRange"];

    if (
      guidance &&
      (guidance.low !== undefined || guidance.high !== undefined)
    ) {
      guidanceRange = {
        low: guidance.low,
        high: guidance.high,
        midpoint: guidance.midpoint,
        quote: guidance.quote,
        secUrl: guidance.secUrl,
      };

      const lowNum = guidance.low ? parseFloat(guidance.low) : undefined;
      const highNum = guidance.high ? parseFloat(guidance.high) : undefined;

      if (!isNaN(currentNum)) {
        if (highNum !== undefined && currentNum > highNum) {
          guidanceComparison = "above";
        } else if (lowNum !== undefined && currentNum < lowNum) {
          guidanceComparison = "below";
        } else if (lowNum !== undefined && highNum !== undefined) {
          guidanceComparison = "within";
        }
      }
    }

    metrics.push({
      metricName: fact.label || fact.concept,
      concept: fact.concept,
      unit: fact.unit,
      reportedValue: fact.val,
      reportedCitation,
      priorPeriodValue,
      priorPeriodCitation,
      priorYearValue,
      priorYearCitation,
      guidanceRange,
      guidanceComparison,
      deltaQoQPercent,
      deltaYoYPercent,
    });
  }

  return metrics;
}
