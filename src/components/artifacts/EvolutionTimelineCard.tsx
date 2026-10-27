import type { TechnologyEvolutionTimeline } from "../../lib/artifacts/types";
import { localDate } from "../../lib/time";
import type { ArtifactSourceView } from "../../server/publication/events";
import { ArtifactSources } from "./ArtifactSources";
import { SectionHead } from "../SectionHead";

export function EvolutionTimelineCard({
  timeline,
  sources,
}: {
  timeline: TechnologyEvolutionTimeline;
  sources: ArtifactSourceView[];
}) {
  if (sources.length === 0) return null;
  // Each entry is dated by its cited article's publish day (UTC) from the
  // database; the model's date is not shown. Undated entries go last; the
  // sort is stable, so one day keeps the model's order.
  const entries = timeline.entries
    .map((e) => {
      const at = sources.find((s) => s.id === e.source.articleId)?.publishedAt;
      return { e, day: at == null ? null : localDate(at, "UTC") };
    })
    .sort((a, b) => {
      if (a.day === b.day) return 0;
      if (a.day === null) return 1;
      if (b.day === null) return -1;
      return a.day < b.day ? -1 : 1;
    });
  return (
    <section
      aria-label="Technology Evolution Timeline"
      className="min-w-0 border-t border-border pt-6"
    >
      <SectionHead
        title="Evolution timeline"
        note="Releases, evaluations, corrections and adoption milestones reported in these sources."
      />
      <ol className="flex flex-col gap-3">
        {entries.map(({ e, day }, i) => (
          <li key={i} className="min-w-0 border-l-2 border-border pl-3">
            {/* The model's kind, date and dateSource are not shown. */}
            <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span>
                {day === null ? "Date not stated" : `Reported ${day}`}
              </span>
            </p>
            {/* The verified quote, not the model's paraphrase in e.description. */}
            <blockquote className="wrap-anywhere text-sm">
              &quot;{e.source.quote}&quot;{" "}
              <a
                href={`/a/${e.source.articleId}`}
                className="text-xs hover:underline"
              >
                Source
              </a>
            </blockquote>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted-foreground">
        Quotes are checked against the source text; whether a benchmark is
        independent is not verified.
      </p>
      <ArtifactSources sources={sources} />
    </section>
  );
}
