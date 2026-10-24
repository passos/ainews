import type { StoryBrief } from "../../lib/artifacts/types";

export function StoryBriefCard({ brief }: { brief: StoryBrief }) {
  return (
    <section
      aria-label="Story Brief"
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
          ★ AI Story Brief
        </span>
        <span className="font-mono text-[0.68rem] text-muted-foreground">
          4-Point Synthesis
        </span>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1 border-l-2 border-sec pl-3">
          <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            What Happened
          </h3>
          <p className="text-sm leading-relaxed text-foreground">
            {brief.whatHappened}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-sec pl-3">
          <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            What Is New
          </h3>
          <p className="text-sm leading-relaxed text-foreground">
            {brief.whatIsNew}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-sec pl-3">
          <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            What Evidence Exists
          </h3>
          <p className="text-sm leading-relaxed text-foreground">
            {brief.whatEvidenceExists}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-sec pl-3">
          <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            What To Watch Next
          </h3>
          <p className="text-sm leading-relaxed text-foreground">
            {brief.whatToWatchNext}
          </p>
        </div>
      </div>
    </section>
  );
}
