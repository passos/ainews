import type { FinanceRealityCheck } from "../../lib/artifacts/types";

export function FinanceRealityCheckCard({
  check,
}: {
  check: FinanceRealityCheck;
}) {
  return (
    <section
      aria-label="AI-in-Finance Reality Check"
      className="border border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-muted-foreground">
            ⚖ AI-in-Finance Reality Check
          </span>
          <span className="text-[0.68rem] text-muted-foreground">
            Backtest vs. Live Execution Audit
          </span>
        </div>
        <span className="border border-border-strong px-2 py-0.5 text-[0.68rem] font-bold text-muted-foreground capitalize">
          {check.claimType.replace(/_/g, " ")}
        </span>
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <span className="text-xs font-bold text-muted-foreground">
            Claimant:
          </span>{" "}
          <span className="text-sm font-semibold text-foreground">
            {check.claimant}
          </span>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {check.claimSummary}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="border border-border/80 bg-muted/20 p-3 text-xs">
            <h4 className="text-xs font-bold text-muted-foreground">
              Test Period & Benchmark
            </h4>
            <p className="mt-1 leading-relaxed text-foreground">
              {check.testPeriodAndBenchmark}
            </p>
          </div>

          <div className="border border-border/80 bg-muted/20 p-3 text-xs">
            <h4 className="text-xs font-bold text-muted-foreground">
              Assumed Costs & Slippage
            </h4>
            <p className="mt-1 leading-relaxed text-foreground">
              {check.costsAndAssumptions}
            </p>
          </div>
        </div>

        {check.disclosedCautions.length > 0 && (
          <div className="border border-dashed border-border-strong p-3 text-xs">
            <h4 className="text-xs font-bold text-foreground">
              Authors' Disclosed Cautions & Overfitting Warnings
            </h4>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-relaxed text-foreground">
              {check.disclosedCautions.map((caution, idx) => (
                <li key={idx}>{caution}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
