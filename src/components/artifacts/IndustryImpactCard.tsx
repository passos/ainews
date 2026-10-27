import type { IndustryImpactReport } from "../../lib/artifacts/types";
import { SectionHead } from "../SectionHead";

export function IndustryImpactCard({
  report,
}: {
  report: IndustryImpactReport;
}) {
  return (
    <section
      aria-label="Industry Impact Report"
      className="border-t border-border pt-6"
    >
      <SectionHead
        title="Industry impact"
        note="Cross-sector implications and evidence verification"
      />

      <div className="flex flex-col gap-4">
        <div>
          <h4 className="text-xs font-bold text-muted-foreground">
            Transmission Summary
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {report.summary}
          </p>
        </div>

        {report.affectedIndustries.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">
              Affected Industries & Sectors
            </h4>
            <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
              {report.affectedIndustries.map((item, idx) => (
                <div
                  key={idx}
                  className="border border-border/80 bg-muted/20 p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-muted-foreground">
                      {item.industry}
                    </span>
                    {item.basis === "evidence_based" ? (
                      <span className="inline-flex items-center border border-border-strong px-1.5 py-0.5 text-[0.65rem] font-bold text-foreground">
                        Supported
                      </span>
                    ) : (
                      <span className="inline-flex items-center border border-dashed border-border-strong px-1.5 py-0.5 text-[0.65rem] font-bold text-muted-foreground">
                        Speculative
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 leading-relaxed text-foreground">
                    {item.impact}
                  </p>
                  <p className="mt-1 text-[0.7rem] text-muted-foreground">
                    <span className="font-semibold text-foreground/80">
                      Path:{" "}
                    </span>
                    {item.transmissionPath}
                  </p>
                  {item.basis === "evidence_based" && item.citation && (
                    <div className="mt-2 border-t border-border/40 pt-1.5 text-[0.68rem] text-muted-foreground">
                      {item.citation.claimId && (
                        <span className="font-semibold text-muted-foreground">
                          [Claim #{item.citation.claimId}]
                        </span>
                      )}{" "}
                      {item.citation.sourceDomain && (
                        <span className="text-[0.65rem] text-muted-foreground">
                          ({item.citation.sourceDomain})
                        </span>
                      )}{" "}
                      {item.citation.quote && (
                        <span className="italic">
                          &ldquo;{item.citation.quote}&rdquo;
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {report.affectedOccupations.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">
              Affected Occupations & Workflows
            </h4>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {report.affectedOccupations.map((item, idx) => (
                <div
                  key={idx}
                  className="border border-border/80 bg-muted/15 p-2.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-foreground">
                      {item.role}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[0.65rem] text-muted-foreground capitalize">
                        {item.timeframe.replace("_", " ")}
                      </span>
                      {item.basis === "evidence_based" ? (
                        <span className="inline-flex items-center border border-border-strong px-1 py-0.2 text-[0.62rem] font-bold text-foreground">
                          Supported
                        </span>
                      ) : (
                        <span className="inline-flex items-center border border-dashed border-border-strong px-1 py-0.2 text-[0.62rem] font-bold text-muted-foreground">
                          Speculative
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 leading-relaxed text-muted-foreground">
                    {item.impact}
                  </p>
                  {item.basis === "evidence_based" && item.citation && (
                    <div className="mt-1.5 border-t border-border/30 pt-1 text-[0.65rem] text-muted-foreground">
                      {item.citation.claimId && (
                        <span className="font-semibold text-muted-foreground">
                          [Claim #{item.citation.claimId}]
                        </span>
                      )}{" "}
                      {item.citation.sourceDomain && (
                        <span className="text-[0.62rem] text-muted-foreground">
                          ({item.citation.sourceDomain})
                        </span>
                      )}{" "}
                      {item.citation.quote && (
                        <span className="italic">
                          &ldquo;{item.citation.quote}&rdquo;
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {report.decisionImplications.length > 0 && (
          <div className="border-l-2 border-border-strong pl-3 text-xs leading-relaxed">
            <h4 className="text-xs font-bold text-muted-foreground">
              Strategic Decision Implications
            </h4>
            <div className="mt-2 space-y-2">
              {report.decisionImplications.map((rec, idx) => (
                <div key={idx} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-foreground">
                      {rec.decisionMaker}:
                    </span>
                    {rec.basis === "evidence_based" ? (
                      <span className="text-[0.62rem] text-foreground">
                        [Verified]
                      </span>
                    ) : (
                      <span className="text-[0.62rem] text-muted-foreground">
                        [Speculative]
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground">
                    {rec.recommendationOrTradeoff}
                  </p>
                  {rec.basis === "evidence_based" && rec.citation && (
                    <div className="text-[0.65rem] text-muted-foreground">
                      {rec.citation.claimId && (
                        <span className="font-semibold text-muted-foreground">
                          [Claim #{rec.citation.claimId}]
                        </span>
                      )}{" "}
                      {rec.citation.sourceDomain && (
                        <span className="text-[0.62rem] text-muted-foreground">
                          ({rec.citation.sourceDomain})
                        </span>
                      )}{" "}
                      {rec.citation.quote && (
                        <span className="italic">
                          &ldquo;{rec.citation.quote}&rdquo;
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
