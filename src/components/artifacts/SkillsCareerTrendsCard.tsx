import type { SkillsCareerTrends } from "../../lib/artifacts/types";

export function SkillsCareerTrendsCard({
  trends,
}: {
  trends: SkillsCareerTrends;
}) {
  return (
    <section
      aria-label="Skills and Career Trends"
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
          📈 Skills and Career Trends
        </span>
        <span className="font-mono text-[0.68rem] text-muted-foreground">
          Workforce & Occupational Evolution
        </span>
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Macroeconomic / Industrial Shift
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {trends.industryShift}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-green-500/30 bg-green-500/10 p-3 text-xs leading-relaxed">
            <h5 className="font-mono font-bold uppercase tracking-wider text-green-700 dark:text-green-400">
              Emerging & High-Demand Skills
            </h5>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-foreground">
              {trends.emergingSkills.map((sk, idx) => (
                <li key={idx}>{sk}</li>
              ))}
            </ul>
          </div>

          <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs leading-relaxed">
            <h5 className="font-mono font-bold uppercase tracking-wider text-red-700 dark:text-red-400">
              Declining or At-Risk Skills
            </h5>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-foreground">
              {trends.decliningOrAtRiskSkills.map((sk, idx) => (
                <li key={idx}>{sk}</li>
              ))}
            </ul>
          </div>
        </div>

        {trends.affectedOccupations.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Affected Roles & Professions
            </h4>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {trends.affectedOccupations.map((item, idx) => (
                <div
                  key={idx}
                  className="rounded border border-border/80 bg-muted/20 p-2.5 text-xs"
                >
                  <span className="font-mono font-bold text-sec-ink">
                    {item.role}
                  </span>
                  <p className="mt-1 leading-relaxed text-foreground">
                    {item.impact}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {trends.trainingRecommendations.length > 0 && (
          <div className="border-l-2 border-sec pl-3 text-xs leading-relaxed">
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-sec-ink">
              Training & Career Upskilling Recommendations
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
              {trends.trainingRecommendations.map((rec, idx) => (
                <li key={idx}>{rec}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
