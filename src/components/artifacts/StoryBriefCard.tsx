import type { StoryBrief } from "../../lib/artifacts/types";
import type { ArtifactSourceView } from "../../server/publication/events";
import { ArtifactSources } from "./ArtifactSources";
import { SectionHead } from "../SectionHead";

export function StoryBriefCard({
  brief,
  verifiedClaims,
  sources,
}: {
  brief: StoryBrief;
  verifiedClaims?: string[];
  sources: ArtifactSourceView[];
}) {
  if (sources.length === 0) return null;
  return (
    <section aria-label="Story brief" className="border-t border-border pt-6">
      <SectionHead
        title="Story brief"
        note="What happened, what is new, the evidence, what to watch"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h3 className="text-xs font-bold text-muted-foreground">
            What Happened
          </h3>
          <p className="text-sm leading-relaxed text-foreground">
            {brief.whatHappened}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h3 className="text-xs font-bold text-muted-foreground">
            What Is New
          </h3>
          <p className="text-sm leading-relaxed text-foreground">
            {brief.whatIsNew}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h3 className="text-xs font-bold text-muted-foreground">
            What Evidence Exists
          </h3>
          <p className="text-sm leading-relaxed text-foreground">
            {brief.whatEvidenceExists}
          </p>
          {verifiedClaims && verifiedClaims.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {verifiedClaims.slice(0, 3).map((claim, idx) => (
                <li key={idx} className="leading-snug">
                  {claim}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h3 className="text-xs font-bold text-muted-foreground">
            What To Watch Next
          </h3>
          <p className="text-sm leading-relaxed text-foreground">
            {brief.whatToWatchNext}
          </p>
        </div>
      </div>
      <ArtifactSources sources={sources} />
    </section>
  );
}
