import type { SupplyChainRippleMap } from "../../lib/artifacts/types";

export function SupplyChainRippleCard({
  ripple,
}: {
  ripple: SupplyChainRippleMap;
}) {
  return (
    <section
      aria-label="Supply-Chain Ripple Map"
      className="border border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-muted-foreground">
            ⛓️ Supply-Chain Ripple Map
          </span>
          <span className="text-[0.68rem] text-muted-foreground">
            Upstream & Downstream Ramification Modeling
          </span>
        </div>
      </header>

      {/* Prominent Hypothesis Banner (Newsren §3 mandate) */}
      <div className="mb-4 border border-dashed border-border-strong p-2.5 text-xs text-foreground">
        <span className="font-bold">⚠️ Working hypothesis:</span>{" "}
        <span className="leading-relaxed">
          Upstream and downstream ripple effects in the supply chain come from
          an inferred model and transmission hypotheses, not from audited facts.
        </span>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <h4 className="text-xs font-bold text-muted-foreground">
            Focal Transition Node
          </h4>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {ripple.focalNode}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Upstream Ripples */}
          <div className="border border-border/80 bg-muted/15 p-3 text-xs">
            <h5 className="font-bold text-muted-foreground">
              ⬆️ Upstream Dependencies & Suppliers
            </h5>
            <div className="mt-2 space-y-2.5">
              {ripple.upstreamRipples.map((item, idx) => (
                <div
                  key={idx}
                  className="border border-border/60 bg-background/50 p-2.5"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-semibold text-foreground">
                      {item.target}
                    </span>
                    <span className="inline-flex items-center border border-dashed border-border-strong px-1 py-0.2 text-[0.62rem] font-bold text-muted-foreground">
                      Hypothesis ({item.confidence})
                    </span>
                  </div>
                  <p className="mt-1 leading-relaxed text-foreground">
                    {item.effect}
                  </p>
                  <p className="mt-1 text-[0.68rem] text-muted-foreground">
                    <span className="font-semibold text-foreground/80">
                      Channel:{" "}
                    </span>
                    {item.transmissionChannel}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Downstream Ripples */}
          <div className="border border-border/80 bg-muted/15 p-3 text-xs">
            <h5 className="font-bold text-muted-foreground">
              ⬇️ Downstream Integrators & End-Markets
            </h5>
            <div className="mt-2 space-y-2.5">
              {ripple.downstreamRipples.map((item, idx) => (
                <div
                  key={idx}
                  className="border border-border/60 bg-background/50 p-2.5"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-semibold text-foreground">
                      {item.target}
                    </span>
                    <span className="inline-flex items-center border border-dashed border-border-strong px-1 py-0.2 text-[0.62rem] font-bold text-muted-foreground">
                      Hypothesis ({item.confidence})
                    </span>
                  </div>
                  <p className="mt-1 leading-relaxed text-foreground">
                    {item.effect}
                  </p>
                  <p className="mt-1 text-[0.68rem] text-muted-foreground">
                    <span className="font-semibold text-foreground/80">
                      Channel:{" "}
                    </span>
                    {item.transmissionChannel}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {ripple.keyHypotheses.length > 0 && (
          <div className="border-l-2 border-border pl-3 text-xs leading-relaxed">
            <h4 className="text-xs font-bold text-muted-foreground">
              Key Hypotheses & Modeling Assumptions
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
              {ripple.keyHypotheses.map((hyp, idx) => (
                <li key={idx}>{hyp}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
