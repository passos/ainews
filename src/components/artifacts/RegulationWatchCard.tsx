import type { RegulationWatch } from "../../lib/artifacts/types";

export function RegulationWatchCard({ watch }: { watch: RegulationWatch }) {
  return (
    <section
      aria-label="Regulation Watch"
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
            📜 Regulation Watch
          </span>
          <span className="font-mono text-[0.68rem] text-muted-foreground">
            Compliance & Regulatory Intelligence
          </span>
        </div>
        <span className="rounded bg-sec/20 px-2 py-0.5 font-mono text-[0.68rem] font-bold uppercase tracking-wider text-sec-ink">
          {watch.regulator}
        </span>
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-serif text-lg font-bold text-foreground">
            {watch.actionTitle}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {watch.summary}
          </p>
        </div>

        {watch.affectedInstitutions.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Affected Market Participants
            </h4>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {watch.affectedInstitutions.map((inst, idx) => (
                <span
                  key={idx}
                  className="rounded border border-border/80 bg-muted/40 px-2 py-1 text-xs text-foreground"
                >
                  {inst}
                </span>
              ))}
            </div>
          </div>
        )}

        {watch.keyRequirements.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Actionable Mandates & Requirements
            </h4>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-foreground">
              {watch.keyRequirements.map((req, idx) => (
                <li key={idx}>{req}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-border/80 bg-muted/20 p-2.5 text-xs">
            <span className="font-mono font-bold uppercase tracking-wider text-sec-ink">
              Effective Date / Transition:
            </span>
            <p className="mt-1 text-foreground">{watch.effectiveDate}</p>
          </div>

          <div className="rounded border border-border/80 bg-muted/20 p-2.5 text-xs">
            <span className="font-mono font-bold uppercase tracking-wider text-sec-ink">
              Enforcement Context:
            </span>
            <p className="mt-1 text-foreground">{watch.enforcementContext}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
