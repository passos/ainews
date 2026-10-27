import type {
  LaunchRealityCheck,
  LaunchVerdict,
} from "../../lib/artifacts/types";
import type { ArtifactSourceView } from "../../server/publication/events";
import { ArtifactSources } from "./ArtifactSources";

const VERDICT_LABELS: Record<LaunchVerdict, string> = {
  independent_support: "Independent evidence supports this claim",
  independent_dispute: "Independent evidence disputes this claim",
  no_independent_evidence: "No independent evidence in these sources",
};

export function LaunchRealityCheckCard({
  check,
  sources,
}: {
  check: LaunchRealityCheck;
  sources: ArtifactSourceView[];
}) {
  if (sources.length === 0) return null;
  // The summary line is counted here, not written by the model.
  const n = check.claims.length;
  const k = check.claims.filter(
    (c) => c.verdict !== "no_independent_evidence",
  ).length;
  return (
    <section
      aria-label="Launch Reality Check"
      className="min-w-0 border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 border-b border-border pb-2">
        <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
          Launch Reality Check
        </h3>
        <p className="wrap-anywhere text-sm">
          {check.subject} · Claims by {check.claimant}
        </p>
        <p className="text-sm text-muted-foreground">
          {k} of {n} {n === 1 ? "claim has" : "claims have"} independent
          evidence in these sources.
        </p>
      </header>
      <ol className="flex flex-col gap-3">
        {check.claims.map((c, i) => (
          <li key={i} className="min-w-0 border-l-2 border-border pl-3">
            <p className="wrap-anywhere text-sm font-bold">{c.claim}</p>
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              {VERDICT_LABELS[c.verdict]}
            </p>
            <blockquote className="wrap-anywhere text-sm">
              &quot;{c.claimQuote.quote}&quot;{" "}
              <a
                href={`/a/${c.claimQuote.articleId}`}
                className="font-mono text-xs hover:underline"
              >
                Claim source
              </a>
            </blockquote>
            {c.independentEvidence.map((e, j) => (
              <blockquote key={j} className="wrap-anywhere text-sm">
                &quot;{e.quote}&quot;{" "}
                <a
                  href={`/a/${e.articleId}`}
                  className="font-mono text-xs hover:underline"
                >
                  Evidence source
                </a>
              </blockquote>
            ))}
          </li>
        ))}
      </ol>
      <ArtifactSources sources={sources} />
    </section>
  );
}
