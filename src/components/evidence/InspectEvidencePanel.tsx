import { useState } from "react";
import type {
  ClaimEvidenceView,
  ClaimView,
  EventEvidenceView,
} from "../../lib/evidence/types";
import {
  originalFragmentHref,
  textFragmentHref,
} from "../../lib/text-fragment";
import { safeHttpUrl } from "../../lib/url";

export function InspectEvidencePanel({
  evidence,
}: {
  evidence: EventEvidenceView;
}) {
  const [openClaimId, setOpenClaimId] = useState<number | null>(() => {
    // Open the first claim by default if available
    return evidence.claims.length > 0 ? evidence.claims[0].id : null;
  });

  if (!evidence.claims || evidence.claims.length === 0) {
    return null;
  }

  const toggleClaim = (id: number) => {
    setOpenClaimId((prev) => (prev === id ? null : id));
  };

  return (
    <section
      aria-label="Inspect evidence"
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
            🔍 Inspect Evidence
          </span>
          <span className="font-mono text-[0.68rem] text-muted-foreground">
            {evidence.claims.length}{" "}
            {evidence.claims.length === 1
              ? "claim inspected"
              : "claims inspected"}
          </span>
        </div>
        <p className="font-mono text-[0.65rem] text-muted-foreground">
          Every statement traced directly to verbatim source excerpts
        </p>
      </header>

      <div className="flex flex-col gap-3">
        {evidence.claims.map((claim) => (
          <ClaimRow
            key={claim.id}
            claim={claim}
            isOpen={openClaimId === claim.id}
            onToggle={() => toggleClaim(claim.id)}
          />
        ))}
      </div>
    </section>
  );
}

function ClaimRow({
  claim,
  isOpen,
  onToggle,
}: {
  claim: ClaimView;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const typeBadgeColors = {
    fact: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    interpretation:
      "border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300",
    prediction:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  }[claim.claimType];

  const consensusBadge = {
    verified: {
      text: "Verified",
      classes:
        "border-emerald-600/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold",
    },
    disputed: {
      text: "Disputed",
      classes:
        "border-rose-600/40 bg-rose-500/15 text-rose-700 dark:text-rose-300 font-bold",
    },
    unverified: {
      text: "Unverified",
      classes: "border-border bg-muted/60 text-muted-foreground",
    },
  }[claim.consensusStatus];

  return (
    <div className="rounded border border-border/80 bg-background/50 transition-colors">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-muted/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wider ${typeBadgeColors}`}
            >
              {claim.claimType}
            </span>
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wider ${consensusBadge.classes}`}
            >
              {consensusBadge.text}
            </span>
            {claim.primarySourcePreferred && (
              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-primary">
                Primary source cited
              </span>
            )}
            {claim.realityCheck === "vendor_only" && (
              <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-amber-600 dark:text-amber-400">
                Vendor Claim (Unverified)
              </span>
            )}
            {claim.realityCheck === "independent_verified" && (
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-emerald-600 dark:text-emerald-400">
                Independent Benchmark Confirmed
              </span>
            )}
            {claim.realityCheck === "independent_disputed" && (
              <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-red-600 dark:text-red-400">
                Disputed by Independent Benchmark
              </span>
            )}
            <span className="font-mono text-[0.65rem] text-muted-foreground">
              {claim.evidence.length}{" "}
              {claim.evidence.length === 1
                ? "source citation"
                : "source citations"}
            </span>
          </div>

          <p className="font-serif text-sm font-semibold leading-snug text-foreground">
            {claim.claimText}
          </p>
        </div>

        <span
          className="font-mono text-xs text-muted-foreground"
          aria-hidden="true"
        >
          {isOpen ? "▲" : "▼"}
        </span>
      </button>

      {isOpen && (
        <div className="border-t border-border/60 bg-muted/20 p-3 pt-2">
          {claim.evidence.length === 0 ? (
            <p className="font-mono text-xs italic text-muted-foreground">
              No verified source excerpts available for this claim.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {claim.evidence.map((cit) => (
                <div
                  key={cit.id}
                  className="rounded border border-border/60 bg-card p-2.5 text-xs shadow-xs"
                >
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.2 font-mono text-[0.62rem] font-bold uppercase tracking-wider ${
                          cit.stance === "support"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                        }`}
                      >
                        {cit.stance === "support" ? "Supports" : "Disputes"}
                      </span>
                      {cit.isPrimarySource && (
                        <span className="rounded bg-sec/20 px-1.5 py-0.2 font-mono text-[0.62rem] font-bold uppercase tracking-wider text-sec-ink">
                          ★ Original source
                        </span>
                      )}
                      <span
                        className={`rounded border px-1.5 py-0.2 font-mono text-[0.62rem] font-semibold uppercase tracking-wider ${
                          cit.sourceRole === "vendor"
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                        }`}
                      >
                        {cit.sourceRole === "vendor" ? "Vendor" : "Independent"}
                      </span>
                      <span className="font-mono text-[0.68rem] text-muted-foreground">
                        {cit.sourceName} ({cit.sourceDomain})
                      </span>
                    </div>

                    {cit.articleUrl && safeHttpUrl(cit.articleUrl) && (
                      <a
                        href={safeHttpUrl(cit.articleUrl)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[0.68rem] font-semibold text-primary underline hover:opacity-80"
                      >
                        {cit.articleTitle} ↗
                      </a>
                    )}
                  </div>

                  <blockquote className="border-l-2 border-primary/40 pl-2.5 italic text-foreground/90">
                    "{cit.quote}"
                  </blockquote>
                  <QuoteLink cit={cit} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A quote the reader page shows links there and is highlighted. A quote
// outside what the source's licence lets the page show links to the original,
// also with a text fragment.
function QuoteLink({ cit }: { cit: ClaimEvidenceView }) {
  const original = safeHttpUrl(cit.articleUrl);
  if (cit.inArticle) {
    return (
      <p className="mt-1.5 font-mono text-[0.68rem]">
        <a
          href={textFragmentHref(cit.articleId, cit.quote)}
          className="font-semibold text-sec-ink underline"
        >
          Highlight in article →
        </a>
      </p>
    );
  }
  if (!original) return null;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[0.68rem]">
      <a
        href={originalFragmentHref(original, cit.quote)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-sec-ink underline"
      >
        Highlight in original ↗
      </a>
      <span className="text-muted-foreground">
        {`Quote is in the full article at ${cit.sourceName}`}
      </span>
    </p>
  );
}
