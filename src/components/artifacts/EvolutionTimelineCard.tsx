import type {
  TechnologyEvolutionTimeline,
  TimelineKind,
} from "../../lib/artifacts/types";
import type { ArtifactSourceView } from "../../server/publication/events";
import { ArtifactSources } from "./ArtifactSources";

const KIND_LABELS: Record<TimelineKind, string> = {
  release: "Release",
  evaluation: "Evaluation",
  correction: "Correction",
  adoption: "Adoption",
};

export function EvolutionTimelineCard({
  timeline,
  sources,
}: {
  timeline: TechnologyEvolutionTimeline;
  sources: ArtifactSourceView[];
}) {
  if (sources.length === 0) return null;
  return (
    <section
      aria-label="Technology Evolution Timeline"
      className="min-w-0 border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 border-b border-border pb-2">
        <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
          Technology Evolution Timeline
        </h3>
        <p className="text-sm text-muted-foreground">
          Releases, evaluations, corrections and adoption milestones reported in
          these sources.
        </p>
      </header>
      <ol className="flex flex-col gap-3">
        {timeline.entries.map((e, i) => (
          <li key={i} className="min-w-0 border-l-2 border-border pl-3">
            <p className="flex flex-wrap gap-x-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              <span>{e.date}</span>
              <span>{KIND_LABELS[e.kind]}</span>
              {e.dateSource === "report_published" && (
                <span>Date of report</span>
              )}
            </p>
            <p className="wrap-anywhere text-sm">{e.description}</p>
            <blockquote className="wrap-anywhere text-sm">
              &quot;{e.source.quote}&quot;{" "}
              <a
                href={`/a/${e.source.articleId}`}
                className="font-mono text-xs hover:underline"
              >
                Source
              </a>
            </blockquote>
          </li>
        ))}
      </ol>
      <ArtifactSources sources={sources} />
    </section>
  );
}
