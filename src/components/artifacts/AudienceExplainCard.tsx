import { useEffect, useMemo, useState } from "react";
import {
  type ArtifactAudience,
  type AudienceExplain,
  ARTIFACT_AUDIENCES,
} from "../../lib/artifacts/types";
import type { ArtifactSourceView } from "../../server/publication/events";
import { ArtifactSources } from "./ArtifactSources";

export function AudienceExplainCard({
  explanations,
  initialAudience,
  sources,
}: {
  explanations: Partial<Record<ArtifactAudience, AudienceExplain>>;
  initialAudience?: ArtifactAudience;
  sources: ArtifactSourceView[];
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
  }, [initialAudience, availableAudiences]);

  if (availableAudiences.length === 0 || sources.length === 0) {
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
      className="border-t border-border pt-6"
    >
      <header className="mb-4 flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="text-xs font-bold text-muted-foreground">
            News-to-Learning
          </span>
          <p className="text-[0.68rem] text-muted-foreground">
            Adapted conceptual explanations by reader tier
          </p>
        </div>

        <nav aria-label="Explain for" className="flex items-center gap-1">
          <span className="mr-1 text-xs font-bold text-muted-foreground">
            Explain for
          </span>
          {availableAudiences.map((aud) => {
            const isSelected = aud === selectedAudience;
            return (
              <button
                key={aud}
                type="button"
                onClick={() => setSelectedAudience(aud)}
                className={`min-h-11 border px-3 py-1 text-sm transition-colors ${
                  isSelected
                    ? "border-foreground bg-foreground font-semibold text-background"
                    : "border-border-strong text-foreground hover:bg-muted"
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
          <h4 className="text-xs font-bold text-muted-foreground">Overview</h4>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground">
            {current.overview}
          </p>
        </div>

        {current.keyPoints.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">
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
            <h4 className="text-xs font-bold text-muted-foreground">
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
          <div className="border border-border/80 bg-muted/30 p-3">
            <h4 className="text-xs font-bold text-muted-foreground">
              Glossary of Key Terms
            </h4>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              {current.glossary.map((g, idx) => (
                <div key={idx} className="flex flex-col">
                  <dt className="text-xs font-bold text-foreground">
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
      <ArtifactSources sources={sources} />
    </section>
  );
}
