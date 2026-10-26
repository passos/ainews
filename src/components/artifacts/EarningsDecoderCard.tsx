import type { EarningsDecoder } from "../../lib/artifacts/types";
import { safeHttpUrl } from "../../lib/url";

export interface EarningsDecoderCardProps {
  decoder: EarningsDecoder;
}

// Stored artifact JSON passes z.string().url(), which accepts javascript:.
// Only http(s) links become hrefs.
function safeHref(url: string | undefined): string | null {
  return url ? safeHttpUrl(url) : null;
}

export function EarningsDecoderCard({ decoder }: EarningsDecoderCardProps) {
  const {
    company,
    filing,
    metrics,
    executiveSummary,
    keyDrivers,
    forwardGuidance,
    disclaimer,
  } = decoder;
  const filingHref = safeHref(filing.secUrl);
  const rows = metrics.map((m) => ({
    m,
    href: {
      reported: safeHref(m.reportedCitation?.secUrl),
      priorPeriod: safeHref(m.priorPeriodCitation?.secUrl),
      priorYear: safeHref(m.priorYearCitation?.secUrl),
    },
  }));

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              SEC EDGAR {filing.form}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              CIK: {company.cik}
            </span>
          </div>
          <h3 className="text-xl font-bold mt-1">
            {company.name} ({company.ticker}) Earnings Decoder
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Fiscal Period: {filing.fiscalPeriod} {filing.fiscalYear} | Filed:{" "}
            {filing.filingDate}
          </p>
        </div>

        <div>
          {filingHref && (
            <a
              href={filingHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 border transition-colors"
            >
              <span>View Official SEC Filing</span>
              <span aria-hidden="true">&rarr;</span>
            </a>
          )}
        </div>
      </div>

      {/* Metrics Comparison Table */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Financial Facts & Period Comparisons
        </h4>
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-xs text-left">
            <thead className="bg-muted text-muted-foreground font-semibold">
              <tr>
                <th className="px-3 py-2.5">Metric</th>
                <th className="px-3 py-2.5">Reported</th>
                <th className="px-3 py-2.5">Prior Period (QoQ)</th>
                <th className="px-3 py-2.5">Prior Year (YoY)</th>
                <th className="px-3 py-2.5">Guidance / Status</th>
                <th className="px-3 py-2.5 text-right">SEC Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ m, href }, idx) => (
                <tr key={idx} className="hover:bg-muted/40">
                  <td className="px-3 py-2.5 font-medium">
                    {m.metricName}
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {m.concept}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-semibold">
                    <div>
                      <span>
                        {formatNumberDisplay(m.reportedValue, m.unit)}
                      </span>
                      {href.reported && (
                        <a
                          href={href.reported}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-1 text-[10px] text-primary hover:underline"
                          title={`SEC Source: ${m.reportedCitation.periodEnd || "Reported"}`}
                        >
                          ↗
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {m.priorPeriodValue ? (
                      <div>
                        <span>
                          {formatNumberDisplay(m.priorPeriodValue, m.unit)}
                        </span>
                        {href.priorPeriod && (
                          <a
                            href={href.priorPeriod}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-1 text-[10px] text-primary hover:underline"
                            title={`SEC Source: ${m.priorPeriodCitation?.periodEnd || "Prior Period"}`}
                          >
                            ↗
                          </a>
                        )}
                        {m.deltaQoQPercent && (
                          <span
                            className={`ml-1.5 font-mono text-[11px] ${
                              m.deltaQoQPercent.startsWith("+")
                                ? "text-emerald-600 dark:text-emerald-400"
                                : m.deltaQoQPercent.startsWith("-")
                                  ? "text-rose-600 dark:text-rose-400"
                                  : ""
                            }`}
                          >
                            ({m.deltaQoQPercent})
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {m.priorYearValue ? (
                      <div>
                        <span>
                          {formatNumberDisplay(m.priorYearValue, m.unit)}
                        </span>
                        {href.priorYear && (
                          <a
                            href={href.priorYear}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-1 text-[10px] text-primary hover:underline"
                            title={`SEC Source: ${m.priorYearCitation?.periodEnd || "Prior Year"}`}
                          >
                            ↗
                          </a>
                        )}
                        {m.deltaYoYPercent && (
                          <span
                            className={`ml-1.5 font-mono text-[11px] ${
                              m.deltaYoYPercent.startsWith("+")
                                ? "text-emerald-600 dark:text-emerald-400"
                                : m.deltaYoYPercent.startsWith("-")
                                  ? "text-rose-600 dark:text-rose-400"
                                  : ""
                            }`}
                          >
                            ({m.deltaYoYPercent})
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {m.guidanceComparison === "above" && (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        Above Guidance
                      </span>
                    )}
                    {m.guidanceComparison === "within" && (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                        Within Range
                      </span>
                    )}
                    {m.guidanceComparison === "below" && (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
                        Below Guidance
                      </span>
                    )}
                    {m.guidanceComparison === "not_provided" && (
                      <span className="text-muted-foreground text-[11px]">
                        N/A
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[11px]">
                    {href.reported ? (
                      <a
                        href={href.reported}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                        title={m.reportedCitation.quote || "View SEC Fact"}
                      >
                        [Fact #{m.reportedCitation.factId ?? "SEC"}]
                      </a>
                    ) : (
                      <span className="text-muted-foreground">[Fact]</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Executive Summary */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Executive Financial Summary
        </h4>
        <div className="prose prose-sm dark:prose-invert max-w-none text-foreground text-sm leading-relaxed whitespace-pre-line">
          {executiveSummary}
        </div>
      </div>

      {/* Key Drivers */}
      {keyDrivers && keyDrivers.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Key Business Drivers
          </h4>
          <ul className="list-disc list-inside space-y-1 text-sm text-foreground">
            {keyDrivers.map((driver, idx) => (
              <li key={idx}>{driver}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Forward Guidance */}
      {forwardGuidance && forwardGuidance.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Management Outlook & Forward Commentary
          </h4>
          <ul className="list-disc list-inside space-y-1 text-sm text-foreground">
            {forwardGuidance.map((fg, idx) => (
              <li key={idx}>{fg}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Newsren §4 Finance Guardrail Notice */}
      <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-900 dark:text-amber-200">
        <p className="font-semibold mb-0.5">⚠️ Regulatory disclosure</p>
        <p>{disclaimer}</p>
      </div>
    </div>
  );
}

/** Formats financial fact values (e.g. 94930000000 -> "$94.93B") */
function formatNumberDisplay(valStr: string, unit: string): string {
  const num = parseFloat(valStr);
  if (isNaN(num)) return valStr;

  const isUsd = unit.toLowerCase() === "usd";
  const prefix = isUsd ? "$" : "";

  if (Math.abs(num) >= 1_000_000_000) {
    return `${prefix}${(num / 1_000_000_000).toFixed(2)}B`;
  }
  if (Math.abs(num) >= 1_000_000) {
    return `${prefix}${(num / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(num) >= 1_000) {
    return `${prefix}${(num / 1_000).toFixed(2)}K`;
  }
  return `${prefix}${num.toFixed(2)}`;
}
