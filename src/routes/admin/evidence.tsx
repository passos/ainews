import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { formatUtc } from "../../lib/time";
import {
  decideClaimReview,
  listPendingClaims,
} from "../../server/admin/evidence";

export const Route = createFileRoute("/admin/evidence")({
  ssr: "data-only",
  loader: async () => listPendingClaims(),
  component: AdminEvidencePage,
});

function AdminEvidencePage() {
  const claims = Route.useLoaderData();
  const router = useRouter();
  const [actingId, setActingId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleDecision(
    claimId: number,
    decision: "approved" | "rejected",
    expectedRevision: number,
  ) {
    setActingId(claimId);
    setErrorMessage(null);
    try {
      await decideClaimReview({
        data: {
          claimId,
          decision,
          expectedRevision,
        },
      });
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to submit claim decision",
      );
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="font-serif text-2xl font-bold tracking-tight">
          Evidence & Claims Review Queue
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review extracted factual claims and citations before publication for
          review-mode sections.
        </p>
      </div>

      {errorMessage && (
        <div className="rounded-md bg-destructive/15 p-3 font-mono text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h3 className="font-mono text-sm font-bold uppercase tracking-wider">
            Pending Claims ({claims.length})
          </h3>
          {claims.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
              Needs Approval
            </span>
          )}
        </div>

        {claims.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            No claims currently waiting for review.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {claims.map((c) => (
              <div
                key={c.id}
                className="flex flex-col gap-3 rounded-lg border bg-card p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-sec/15 px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-wider text-sec-ink">
                        {c.industryName}
                      </span>
                      <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                        {c.claimType}
                      </span>
                      <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                        {c.consensusStatus}
                      </span>
                      {c.primarySourcePreferred ? (
                        <span className="rounded bg-blue-500/15 px-2 py-0.5 font-mono text-xs font-semibold text-blue-700 dark:text-blue-400">
                          Primary Preferred
                        </span>
                      ) : null}
                      <span className="font-mono text-xs text-muted-foreground">
                        rev {c.inputRevision}
                      </span>
                    </div>
                    <h4 className="mt-1.5 font-serif text-lg font-bold leading-snug">
                      {c.eventTitle}
                    </h4>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      Extracted {formatUtc(c.createdAt)} using {c.model}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={actingId === c.id}
                      onClick={() =>
                        handleDecision(c.id, "approved", c.inputRevision)
                      }
                      className="rounded-md bg-emerald-600 px-3 py-1.5 font-mono text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {actingId === c.id ? "Saving..." : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={actingId === c.id}
                      onClick={() =>
                        handleDecision(c.id, "rejected", c.inputRevision)
                      }
                      className="rounded-md border border-destructive/40 bg-transparent px-3 py-1.5 font-mono text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>

                <div className="rounded bg-muted/40 p-3 font-sans text-sm leading-relaxed text-foreground">
                  <p>{c.claimText}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
