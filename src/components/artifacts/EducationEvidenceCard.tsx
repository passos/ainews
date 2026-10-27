import type { EducationEvidenceChecker } from "../../lib/artifacts/types";

export function EducationEvidenceCard({
  evidence,
}: {
  evidence: EducationEvidenceChecker;
}) {
  return (
    <section
      aria-label="Education Evidence Checker"
      className="border-t border-border pt-6"
    >
      <header className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <span className="text-xs font-bold text-muted-foreground">
          🔬 Education Evidence Checker
        </span>
        <span className="text-[0.68rem] text-muted-foreground">
          Promotional Claims vs. Empirical Outcomes
        </span>
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <h4 className="text-xs font-bold text-muted-foreground">
            Evaluation Subject
          </h4>
          <p className="mt-0.5 text-sm font-semibold text-foreground">
            {evidence.subject}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="border border-dashed border-border-strong p-3 text-xs leading-relaxed">
            <h5 className="font-bold text-foreground">
              Claimed Outcomes (Promotional)
            </h5>
            <p className="mt-1 text-foreground">{evidence.claimedOutcomes}</p>
          </div>

          <div className="border border-border-strong p-3 text-xs leading-relaxed">
            <h5 className="font-bold text-foreground">
              Measured Outcomes (Empirical)
            </h5>
            <p className="mt-1 text-foreground">{evidence.measuredOutcomes}</p>
          </div>
        </div>

        <div className="border border-border/80 bg-muted/20 p-3 text-xs">
          <h4 className="text-xs font-bold text-muted-foreground">
            Study Design & Methodology
          </h4>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <div>
              <span className="font-bold text-foreground">Population:</span>
              <p className="text-muted-foreground">
                {evidence.studyDesign.samplePopulation}
              </p>
            </div>
            <div>
              <span className="font-bold text-foreground">
                Comparison Group:
              </span>
              <p className="text-muted-foreground">
                {evidence.studyDesign.comparisonGroup}
              </p>
            </div>
            <div>
              <span className="font-bold text-foreground">Metric Used:</span>
              <p className="text-muted-foreground">
                {evidence.studyDesign.metricUsed}
              </p>
            </div>
          </div>
        </div>

        <div className="border-l-2 border-border-strong pl-3 text-xs leading-relaxed">
          <h4 className="text-xs font-bold text-muted-foreground">
            Critical Gap Analysis
          </h4>
          <p className="mt-1 text-foreground">{evidence.promotionalGap}</p>
        </div>

        {evidence.limitations.length > 0 && (
          <div className="border border-border/60 bg-muted/10 p-3 text-xs">
            <h4 className="text-xs font-bold text-muted-foreground">
              Documented Limitations
            </h4>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
              {evidence.limitations.map((lim, idx) => (
                <li key={idx}>{lim}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
