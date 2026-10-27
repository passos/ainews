import type {
  LaunchRealityCheck,
  LaunchVerdict,
} from "../../lib/artifacts/types";
import type { ArtifactSourceView } from "../../server/publication/events";
import { ArtifactSources } from "./ArtifactSources";

// The verdict is the model's reading of the evidence; code cannot verify it.
const VERDICT_LABELS: Record<LaunchVerdict, string> = {
  independent_support: "Other outlets report supporting evidence",
  independent_dispute: "Other outlets report contrary evidence",
  no_independent_evidence: "No other outlet reports evidence",
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
  // A mechanical fact: claims with at least one retained evidence item,
  // whatever the model's verdict says.
  const k = check.claims.filter((c) => c.independentEvidence.length > 0).length;
  return (
    <section
      aria-label="Launch Reality Check"
      className="min-w-0 border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 border-b border-border pb-2">
        <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
          Launch Reality Check
        </h3>
        {/* The subject is a grounded name. The claimant is not shown: the
            quote and its source article stand for who made the claim. */}
        <p className="wrap-anywhere text-sm">{check.subject}</p>
        <p className="text-sm text-muted-foreground">
          {k} of {n} {n === 1 ? "claim has" : "claims have"} evidence from other
          outlets in these sources.
        </p>
      </header>
      <ol className="flex flex-col gap-3">
        {check.claims.map((c, i) => {
          const title = sources.find(
            (s) => s.id === c.claimQuote.articleId,
          )?.title;
          return (
            <li key={i} className="min-w-0 border-l-2 border-border pl-3">
              {/* The verified quote, not the model's paraphrase in c.claim. */}
              <p className="wrap-anywhere text-sm font-bold">
                &quot;{c.claimQuote.quote}&quot;
                {title !== undefined && <> &mdash; quoted in {title}</>}{" "}
                <a
                  href={`/a/${c.claimQuote.articleId}`}
                  className="font-mono text-xs font-normal hover:underline"
                >
                  Claim source
                </a>
              </p>
              <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                Model assessment: {VERDICT_LABELS[c.verdict]}
              </p>
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
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-muted-foreground">
        Quotes are checked against the source text; whether a benchmark is
        independent is not verified.
      </p>
      <ArtifactSources sources={sources} />
    </section>
  );
}
