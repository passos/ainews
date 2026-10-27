import { useState } from "react";
import type {
  ClaimEvidenceView,
  ClaimView,
  EventEvidenceView,
} from "../../lib/evidence/types";
import { stripMarkdownLinks } from "../../lib/quote-display";
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
      className="border border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-muted-foreground">
            🔍 Inspect Evidence
          </span>
          <span className="text-[0.68rem] text-muted-foreground">
            {evidence.claims.length}{" "}
            {evidence.claims.length === 1
              ? "claim inspected"
              : "claims inspected"}
          </span>
        </div>
        <p className="text-[0.65rem] text-muted-foreground">
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
    fact: "border-border-strong text-foreground",
    interpretation: "border-border-strong text-muted-foreground",
    prediction: "border-dashed border-border-strong text-muted-foreground",
  }[claim.claimType];

  const consensusBadge = {
    verified: {
      text: "Supported · model assessment",
      classes: "border-foreground text-foreground font-semibold",
    },
    disputed: {
      text: "Disputed · model assessment",
      classes: "border-destructive text-destructive font-bold",
    },
    unverified: {
      text: "Unverified",
      classes: "border-dashed border-border-strong text-muted-foreground",
    },
  }[claim.consensusStatus];

  return (
    <div className="border border-border/80 bg-background/50 transition-colors">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-muted/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`border px-1.5 py-0.5 text-[0.65rem] capitalize ${typeBadgeColors}`}
            >
              {claim.claimType}
            </span>
            <span
              className={`border px-1.5 py-0.5 text-[0.65rem] ${consensusBadge.classes}`}
            >
              {consensusBadge.text}
            </span>
            {claim.primarySourcePreferred && (
              <span className="border border-foreground px-1.5 py-0.5 text-[0.65rem] font-semibold text-foreground">
                Primary source cited
              </span>
            )}
            {claim.realityCheck === "vendor_only" && (
              <span className="border border-dashed border-border-strong px-1.5 py-0.5 text-[0.65rem] font-semibold text-muted-foreground">
                Model assessment: vendor claim only
              </span>
            )}
            {claim.realityCheck === "independent_verified" && (
              <span className="border border-border-strong px-1.5 py-0.5 text-[0.65rem] font-semibold text-foreground">
                Model assessment: independent support
              </span>
            )}
            {claim.realityCheck === "independent_disputed" && (
              <span className="border border-destructive px-1.5 py-0.5 text-[0.65rem] font-semibold text-destructive">
                Model assessment: disputed by independent source
              </span>
            )}
            <span className="text-[0.65rem] text-muted-foreground">
              {claim.evidence.length}{" "}
              {claim.evidence.length === 1
                ? "source citation"
                : "source citations"}
            </span>
          </div>

          <p className="font-heading text-sm font-semibold leading-snug text-foreground tracking-tight">
            {claim.claimText}
          </p>
        </div>

        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {isOpen ? "▲" : "▼"}
        </span>
      </button>

      {isOpen && (
        <div className="border-t border-border/60 bg-muted/20 p-3 pt-2">
          {claim.evidence.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              No verified source excerpts available for this claim.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {claim.evidence.map((cit) => (
                <div
                  key={cit.id}
                  className="border border-border/60 bg-card p-2.5 text-xs"
                >
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`border px-1.5 py-0.2 text-[0.62rem] font-bold ${
                          cit.stance === "support"
                            ? "border-foreground text-foreground"
                            : "border-destructive text-destructive"
                        }`}
                      >
                        {cit.stance === "support" ? "Supports" : "Disputes"}
                      </span>
                      {cit.isPrimarySource && (
                        <span className="border border-border-strong px-1.5 py-0.2 text-[0.62rem] font-bold text-muted-foreground">
                          ★ Original source
                        </span>
                      )}
                      <span
                        className={`border px-1.5 py-0.2 text-[0.62rem] font-semibold ${
                          cit.sourceRole === "vendor"
                            ? "border-dashed border-border-strong text-muted-foreground"
                            : "border-border-strong text-foreground"
                        }`}
                      >
                        {cit.sourceRole === "vendor"
                          ? "Vendor · model assessment"
                          : "Independent · model assessment"}
                      </span>
                      <span className="text-[0.68rem] text-muted-foreground">
                        {cit.sourceName} ({cit.sourceDomain})
                      </span>
                    </div>

                    {cit.articleUrl && safeHttpUrl(cit.articleUrl) && (
                      <a
                        href={safeHttpUrl(cit.articleUrl)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[0.68rem] font-semibold text-primary underline hover:opacity-80"
                      >
                        {cit.articleTitle} ↗
                      </a>
                    )}
                  </div>

                  <blockquote className="border-l-2 border-primary/40 pl-2.5 italic text-foreground/90">
                    "{stripMarkdownLinks(cit.quote)}"
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
      <p className="mt-1.5 text-[0.68rem]">
        <a
          href={textFragmentHref(cit.articleId, cit.quote)}
          className="font-semibold text-foreground underline"
        >
          Highlight in article →
        </a>
      </p>
    );
  }
  if (!original) return null;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.68rem]">
      <a
        href={originalFragmentHref(original, cit.quote)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-foreground underline"
      >
        Highlight in original ↗
      </a>
      <span className="text-muted-foreground">
        {`Quote is in the full article at ${cit.sourceName}`}
      </span>
    </p>
  );
}
