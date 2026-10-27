import type { ResearchPaperDecoder } from "../../lib/artifacts/types";
import { SectionHead } from "../SectionHead";

export function PaperDecoderCard({
  decoder,
}: {
  decoder: ResearchPaperDecoder;
}) {
  return (
    <section
      aria-label="Research Paper Decoder"
      className="border-t border-border pt-6"
    >
      <SectionHead
        title="Paper decoder"
        note="Hypothesis, method, findings, limitations, applications"
      />

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
