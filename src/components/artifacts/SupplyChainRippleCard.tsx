import type { SupplyChainRippleMap } from "../../lib/artifacts/types";

export function SupplyChainRippleCard({
  ripple,
}: {
  ripple: SupplyChainRippleMap;
}) {
  return (
    <section
      aria-label="Supply-Chain Ripple Map"
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
            ⛓️ Supply-Chain Ripple Map
          </span>
          <span className="font-mono text-[0.68rem] text-muted-foreground">
            Upstream & Downstream Ramification Modeling
          </span>
        </div>
      </header>

      {/* Prominent Hypothesis Banner (Newsren §3 mandate) */}
      <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
        <span className="font-mono font-bold uppercase tracking-wider">
          ⚠️ 假说推演 / Working Hypothesis:
        </span>{" "}
        <span className="leading-relaxed">
          供应链上下游波及效应均为推演模型与传导假说，非审计后确凿事实。
        </span>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Focal Transition Node
          </h4>
          <p className="mt-1 font-mono text-sm font-semibold text-foreground">
            {ripple.focalNode}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Upstream Ripples */}
          <div className="rounded border border-border/80 bg-muted/15 p-3 text-xs">
            <h5 className="font-mono font-bold uppercase tracking-wider text-sec-ink">
              ⬆️ Upstream Dependencies & Suppliers
            </h5>
            <div className="mt-2 space-y-2.5">
              {ripple.upstreamRipples.map((item, idx) => (
                <div
                  key={idx}
                  className="rounded border border-border/60 bg-background/50 p-2.5"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-mono font-semibold text-foreground">
                      {item.target}
                    </span>
                    <span className="inline-flex items-center rounded bg-amber-500/15 px-1 py-0.2 font-mono text-[0.62rem] font-bold text-amber-700 dark:text-amber-400">
                      Hypothesis ({item.confidence})
                    </span>
                  </div>
                  <p className="mt-1 leading-relaxed text-foreground">
                    {item.effect}
                  </p>
                  <p className="mt-1 font-mono text-[0.68rem] text-muted-foreground">
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
          <div className="rounded border border-border/80 bg-muted/15 p-3 text-xs">
            <h5 className="font-mono font-bold uppercase tracking-wider text-sec-ink">
              ⬇️ Downstream Integrators & End-Markets
            </h5>
            <div className="mt-2 space-y-2.5">
              {ripple.downstreamRipples.map((item, idx) => (
                <div
                  key={idx}
                  className="rounded border border-border/60 bg-background/50 p-2.5"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-mono font-semibold text-foreground">
                      {item.target}
                    </span>
                    <span className="inline-flex items-center rounded bg-amber-500/15 px-1 py-0.2 font-mono text-[0.62rem] font-bold text-amber-700 dark:text-amber-400">
                      Hypothesis ({item.confidence})
                    </span>
                  </div>
                  <p className="mt-1 leading-relaxed text-foreground">
                    {item.effect}
                  </p>
                  <p className="mt-1 font-mono text-[0.68rem] text-muted-foreground">
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
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
