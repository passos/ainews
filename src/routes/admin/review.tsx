import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { reanalyzeArticle } from "../../server/admin/articles";
import { listIndustries } from "../../server/admin/industries";
import {
  decideReview,
  listPendingArticles,
  listStuckArticles,
} from "../../server/admin/review";

export const Route = createFileRoute("/admin/review")({
  ssr: "data-only",
  loader: async () => {
    const [pending, stuck, industries] = await Promise.all([
      listPendingArticles(),
      listStuckArticles(),
      listIndustries(),
    ]);
    return { pending, stuck, industries };
  },
  component: AdminReviewPage,
});

function AdminReviewPage() {
  const { pending, stuck, industries } = Route.useLoaderData();
  const router = useRouter();
  const [selectedIndustry, setSelectedIndustry] = useState<number | "all">(
    "all",
  );
  const [submittingId, setSubmittingId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const filteredPending =
    selectedIndustry === "all"
      ? pending
      : pending.filter((a) => a.industryId === selectedIndustry);

  async function handleDecision(
    articleId: number,
    bodySha: string,
    decision: "approved" | "rejected",
  ) {
    setSubmittingId(articleId);
    setErrorMessage(null);
    try {
      await decideReview({
        data: {
          articleId,
          bodySha,
          decision,
        },
      });
      await router.invalidate();
    } catch (err) {
      if (err instanceof Response && err.status === 409) {
        setErrorMessage(
          `Conflict on article #${articleId}: article body was updated during review. Refreshing list...`,
        );
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : `Failed to record review decision: ${String(err)}`,
        );
      }
      await router.invalidate();
    } finally {
      setSubmittingId(null);
    }
  }

  async function handleReanalyze(articleId: number) {
    setSubmittingId(articleId);
    setErrorMessage(null);
    try {
      await reanalyzeArticle({
        data: { articleId, expectedStage: "body_ready" },
      });
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : `Failed to reanalyze: ${String(err)}`,
      );
    } finally {
      setSubmittingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Review Queue</h1>
          <p className="text-sm text-muted-foreground">
            Approve or reject candidate articles before publication. Decisions
            bind strictly to the body hash.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor="industry-filter"
            className="text-xs font-medium text-muted-foreground"
          >
            Filter Section:
          </label>
          <select
            id="industry-filter"
            className="rounded-md border bg-background px-3 py-1 text-sm"
            value={selectedIndustry}
            onChange={(e) =>
              setSelectedIndustry(
                e.target.value === "all" ? "all" : Number(e.target.value),
              )
            }
          >
            <option value="all">All Sections ({pending.length})</option>
            {industries.map((ind) => {
              const count = pending.filter(
                (a) => a.industryId === ind.id,
              ).length;
              return (
                <option key={ind.id} value={ind.id}>
                  {ind.name} ({count})
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {/* Pending Articles List */}
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">
          Pending Articles ({filteredPending.length})
        </h2>

        {filteredPending.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            No articles pending review in this section.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {filteredPending.map((art) => (
              <div
                key={art.id}
                className="flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-foreground/30"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">
                        {art.industryName}
                      </span>
                      {art.score !== null && (
                        <span className="text-xs font-mono text-muted-foreground">
                          Score: {art.score}
                        </span>
                      )}
                      <span className="text-xs font-mono text-muted-foreground">
                        ID: #{art.id}
                      </span>
                    </div>
                    <Link
                      to="/admin/articles/$articleId"
                      params={{ articleId: String(art.id) }}
                      className="font-serif text-base font-bold hover:underline"
                    >
                      {art.title}
                    </Link>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={submittingId === art.id || !art.bodySha}
                      onClick={() =>
                        art.bodySha &&
                        handleDecision(art.id, art.bodySha, "approved")
                      }
                      className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={submittingId === art.id || !art.bodySha}
                      onClick={() =>
                        art.bodySha &&
                        handleDecision(art.id, art.bodySha, "rejected")
                      }
                      className="rounded border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>

                {art.summary && (
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {art.summary}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-4">
                    <a
                      href={art.canonicalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      Source Link &rarr;
                    </a>
                    {art.tags && <span>Tags: {art.tags}</span>}
                  </div>
                  <span className="font-mono text-[0.7rem]">
                    body_sha: {art.bodySha?.slice(0, 12)}...
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stuck Articles Section */}
      <div className="flex flex-col gap-4 border-t pt-8">
        <div>
          <h2 className="text-lg font-semibold text-amber-500">
            Stuck Articles ({stuck.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Articles at body_ready stage with requeue_count &ge; 3.
          </p>
        </div>

        {stuck.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No stuck articles detected.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {stuck.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">#{item.id}</span>
                    <span>{item.title}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>Requeues: {item.requeueCount}</span>
                    <span>Last Call: {item.lastCallStatus ?? "none"}</span>
                    {item.lastCallError && (
                      <span className="text-destructive">
                        Error: {item.lastCallError}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={submittingId === item.id}
                  onClick={() => handleReanalyze(item.id)}
                  className="rounded border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  Reanalyze
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
