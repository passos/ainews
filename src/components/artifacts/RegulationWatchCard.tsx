import type { RegulationWatch } from "../../lib/artifacts/types";
import { SectionHead } from "../SectionHead";

export function RegulationWatchCard({ watch }: { watch: RegulationWatch }) {
  return (
    <section
      aria-label="Regulation Watch"
      className="border-t border-border pt-6"
    >
      <SectionHead
        title="Regulation watch"
        note="Compliance and regulatory intelligence"
      >
        <span className="border border-border-strong px-2 py-0.5 text-[0.68rem] font-bold text-muted-foreground">
          {watch.regulator}
        </span>
      </SectionHead>

      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-heading text-lg font-semibold text-foreground tracking-tight">
            {watch.actionTitle}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {watch.summary}
          </p>
        </div>

        {watch.affectedInstitutions.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">
              Affected Market Participants
            </h4>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {watch.affectedInstitutions.map((inst, idx) => (
                <span
                  key={idx}
                  className="border border-border/80 bg-muted/40 px-2 py-1 text-xs text-foreground"
                >
                  {inst}
                </span>
              ))}
            </div>
          </div>
        )}

        {watch.keyRequirements.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">
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
          <div className="border border-border/80 bg-muted/20 p-2.5 text-xs">
            <span className="font-bold text-muted-foreground">
              Effective Date / Transition:
            </span>
            <p className="mt-1 text-foreground">{watch.effectiveDate}</p>
          </div>

          <div className="border border-border/80 bg-muted/20 p-2.5 text-xs">
            <span className="font-bold text-muted-foreground">
              Enforcement Context:
            </span>
            <p className="mt-1 text-foreground">{watch.enforcementContext}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
