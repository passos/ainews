import type { PolicyImpactExplorer } from "../../lib/artifacts/types";

export function PolicyImpactCard({ policy }: { policy: PolicyImpactExplorer }) {
  return (
    <section
      aria-label="Policy Impact Explorer"
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
          🏛 Policy Impact Explorer
        </span>
        <span className="font-mono text-[0.68rem] text-muted-foreground">
          Education Policy Analysis
        </span>
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-serif text-lg font-bold text-foreground">
            {policy.policyName}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {policy.summary}
          </p>
        </div>

        {policy.affectedAudiences.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Who It Affects & Key Consequences
            </h4>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {policy.affectedAudiences.map((item, idx) => (
                <div
                  key={idx}
                  className="rounded border border-border/80 bg-muted/20 p-2.5"
                >
                  <span className="font-mono text-xs font-bold text-sec-ink">
                    {item.group}
                  </span>
                  <p className="mt-1 text-xs leading-relaxed text-foreground">
                    {item.impact}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {policy.timeline.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Implementation Timeline
            </h4>
            <div className="mt-2 flex flex-col gap-1.5 border-l-2 border-sec pl-3">
              {policy.timeline.map((item, idx) => (
                <div key={idx} className="text-xs">
                  <span className="font-mono font-bold text-foreground">
                    {item.phase}:
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {item.milestone}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {policy.remainingUncertainties.length > 0 && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3">
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400">
              Remaining Uncertainties & Open Questions
            </h4>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-foreground">
              {policy.remainingUncertainties.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
