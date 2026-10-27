import { useState } from "react";
import { isApprovedReview } from "../../lib/approved-review";

// #87 A3b: admin Remove from site / Restore. Both pages call the existing
// decideReview server function; this file only holds the controls.

export const REMOVE_CONFIRM_TEXT =
  "Remove this article from the public site? It leaves every page and feed, and its story is rebuilt from the reports that remain.";

export type CurrentDecision = "approved" | "rejected" | null;

/**
 * The decision for the article's current body, or null when that body has
 * no review. Reviews are unique on (article, body), so at most one matches.
 */
export function currentDecision(
  reviews: readonly { bodySha: string; decision: string }[],
  bodySha: string | null | undefined,
): CurrentDecision {
  // "Approved" keeps its one admin-side definition (isApprovedReview).
  if (reviews.some((review) => isApprovedReview(review, bodySha)))
    return "approved";
  const rejected = reviews.some(
    (review) => review.bodySha === bodySha && review.decision === "rejected",
  );
  return rejected ? "rejected" : null;
}

/** Stateless two-step confirm: step one is the Remove button. */
export function RemoveConfirm({
  confirming,
  working,
  onStart,
  onConfirm,
  onCancel,
}: {
  confirming: boolean;
  working: boolean;
  onStart: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!confirming) {
    return (
      <button
        type="button"
        disabled={working}
        onClick={onStart}
        className="rounded border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50"
      >
        Remove
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2" role="alert">
      <p className="text-xs text-destructive">{REMOVE_CONFIRM_TEXT}</p>
      <button
        type="button"
        disabled={working}
        onClick={onConfirm}
        className="rounded bg-destructive px-3 py-1 text-xs font-semibold text-white hover:bg-destructive/90 disabled:opacity-50"
      >
        Confirm
      </button>
      <button
        type="button"
        disabled={working}
        onClick={onCancel}
        className="rounded border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  );
}

/** Remove with an inline confirm step. No window.confirm. */
export function RemoveButton({
  working,
  onConfirm,
}: {
  working: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <RemoveConfirm
      confirming={confirming}
      working={working}
      onStart={() => setConfirming(true)}
      onCancel={() => setConfirming(false)}
      onConfirm={() => {
        setConfirming(false);
        void onConfirm();
      }}
    />
  );
}

/** Article page panel: Remove when approved, Restore when rejected. */
export function TakedownPanel({
  decision,
  working,
  onRemove,
  onRestore,
}: {
  decision: CurrentDecision;
  working: boolean;
  onRemove: () => void | Promise<void>;
  onRestore: () => void | Promise<void>;
}) {
  if (decision === null) return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-5">
      <h2 className="text-base font-semibold">Remove from site</h2>
      {decision === "approved" ? (
        <>
          <p className="text-xs text-muted-foreground">
            This article is on the public site.
          </p>
          <div>
            <RemoveButton working={working} onConfirm={onRemove} />
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            This article was rejected or removed. Restore puts it back on the
            public site.
          </p>
          <div>
            <button
              type="button"
              disabled={working}
              onClick={() => void onRestore()}
              className="rounded border px-3 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-50"
            >
              Restore
            </button>
          </div>
        </>
      )}
    </section>
  );
}
