import type { SkillsCareerTrends } from "../../lib/artifacts/types";

export function SkillsCareerTrendsCard({
  trends,
}: {
  trends: SkillsCareerTrends;
}) {
  return (
    <section
      aria-label="Skills and Career Trends"
      className="border border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <span className="text-xs font-bold text-muted-foreground">
          📈 Skills and Career Trends
        </span>
        <span className="text-[0.68rem] text-muted-foreground">
          Workforce & Occupational Evolution
        </span>
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <h4 className="text-xs font-bold text-muted-foreground">
            Macroeconomic / Industrial Shift
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {trends.industryShift}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="border border-border-strong p-3 text-xs leading-relaxed">
            <h5 className="font-bold text-foreground">
              Emerging & High-Demand Skills
            </h5>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-foreground">
              {trends.emergingSkills.map((sk, idx) => (
                <li key={idx}>{sk}</li>
              ))}
            </ul>
          </div>

          <div className="border border-border-strong p-3 text-xs leading-relaxed">
            <h5 className="font-bold text-foreground">
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
            <h4 className="text-xs font-bold text-muted-foreground">
              Affected Roles & Professions
            </h4>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {trends.affectedOccupations.map((item, idx) => (
                <div
                  key={idx}
                  className="border border-border/80 bg-muted/20 p-2.5 text-xs"
                >
                  <span className="font-bold text-muted-foreground">
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
          <div className="border-l-2 border-border-strong pl-3 text-xs leading-relaxed">
            <h4 className="text-xs font-bold text-muted-foreground">
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
