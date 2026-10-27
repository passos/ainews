import type { ResearchPaperDecoder } from "../../lib/artifacts/types";

export function PaperDecoderCard({
  decoder,
}: {
  decoder: ResearchPaperDecoder;
}) {
  return (
    <section
      aria-label="Research Paper Decoder"
      className="border border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <span className="text-xs font-bold text-muted-foreground">
          🔬 Research Paper Decoder
        </span>
        <span className="text-[0.68rem] text-muted-foreground">
          Hypothesis · Method · Findings · Limitations · Applications
        </span>
      </header>

      <div className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h4 className="text-xs font-bold text-muted-foreground">
            1. Hypothesis & Problem
          </h4>
          <p className="text-sm leading-relaxed text-foreground">
            {decoder.hypothesis}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h4 className="text-xs font-bold text-muted-foreground">
            2. Methodology & Architecture
          </h4>
          <p className="text-sm leading-relaxed text-foreground">
            {decoder.method}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h4 className="text-xs font-bold text-muted-foreground">
            3. Empirical Findings & Benchmarks
          </h4>
          <p className="text-sm leading-relaxed text-foreground">
            {decoder.findings}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h4 className="text-xs font-bold text-muted-foreground">
            4. Caveats & Limitations
          </h4>
          <p className="text-sm leading-relaxed text-foreground">
            {decoder.limitations}
          </p>
        </div>

        <div className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <h4 className="text-xs font-bold text-muted-foreground">
            5. Downstream Applications
          </h4>
          <p className="text-sm leading-relaxed text-foreground">
            {decoder.applications}
          </p>
        </div>
      </div>
    </section>
  );
}
