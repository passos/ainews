import { useEffect, useMemo, useState } from "react";
import {
  type ArtifactAudience,
  type AudienceExplain,
  ARTIFACT_AUDIENCES,
} from "../../lib/artifacts/types";

export function AudienceExplainCard({
  explanations,
  initialAudience,
}: {
  explanations: Partial<Record<ArtifactAudience, AudienceExplain>>;
  initialAudience?: ArtifactAudience;
}) {
  const availableAudiences = useMemo(
    () => ARTIFACT_AUDIENCES.filter((aud) => !!explanations[aud]),
    [explanations],
  );

  const resolveAudience = (pref?: ArtifactAudience): ArtifactAudience => {
    if (pref && availableAudiences.includes(pref)) {
      return pref;
    }
    return availableAudiences[0] || "student";
  };

  const [selectedAudience, setSelectedAudience] = useState<ArtifactAudience>(
    () => resolveAudience(initialAudience),
  );

  useEffect(() => {
    if (initialAudience && availableAudiences.includes(initialAudience)) {
      setSelectedAudience(initialAudience);
    }
  }, [initialAudience]);

  if (availableAudiences.length === 0) {
    return null;
  }

  const current =
    explanations[selectedAudience] || explanations[availableAudiences[0]];
  if (!current) {
    return null;
  }

  return (
    <section
      aria-label="Audience Explanations"
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
            News-to-Learning
          </span>
          <p className="font-mono text-[0.68rem] text-muted-foreground">
            Adapted conceptual explanations by reader tier
          </p>
        </div>

        <nav aria-label="Audience tiers" className="flex items-center gap-1">
          {availableAudiences.map((aud) => {
            const isSelected = aud === selectedAudience;
            return (
              <button
                key={aud}
                type="button"
                onClick={() => setSelectedAudience(aud)}
                className={`rounded border px-2.5 py-1 font-mono text-xs font-bold uppercase tracking-wider transition-colors ${
                  isSelected
                    ? "border-sec-ink bg-sec-ink text-white dark:text-black"
                    : "border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {aud}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Overview
          </h4>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground">
            {current.overview}
          </p>
        </div>

        {current.keyPoints.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Key Concepts & Takeaways
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm leading-relaxed text-foreground">
              {current.keyPoints.map((pt, idx) => (
                <li key={idx}>{pt}</li>
              ))}
            </ul>
          </div>
        )}

        {current.implications.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Practical Implications
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm leading-relaxed text-foreground">
              {current.implications.map((imp, idx) => (
                <li key={idx}>{imp}</li>
              ))}
            </ul>
          </div>
        )}

        {current.glossary.length > 0 && (
          <div className="rounded border border-border/80 bg-muted/30 p-3">
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
              Glossary of Key Terms
            </h4>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              {current.glossary.map((g, idx) => (
                <div key={idx} className="flex flex-col">
                  <dt className="font-mono text-xs font-bold text-foreground">
                    {g.term}
                  </dt>
                  <dd className="text-xs text-muted-foreground">
                    {g.definition}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
