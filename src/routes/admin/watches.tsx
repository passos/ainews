import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
  createWatch,
  decideWatchHitReview,
  listPendingWatchHits,
  listWatches,
  listWatchHits,
  updateWatch,
} from "../../server/admin/watches";
import type { AdminWatchItem, WatchHitStatus } from "../../server/admin/ops";
import { ADMIN_TABLE } from "../../components/admin/table";

export const Route = createFileRoute("/admin/watches")({
  ssr: "data-only",
  loader: async () => {
    const [watches, pendingHits] = await Promise.all([
      listWatches(),
      listPendingWatchHits(),
    ]);
    return { watches, pendingHits };
  },
  component: AdminWatchesPage,
});

function AdminWatchesPage() {
  const router = useRouter();
  const { watches: initialWatches, pendingHits } = Route.useLoaderData();
  const [actingHitId, setActingHitId] = useState<number | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [watches, setWatches] = useState<AdminWatchItem[]>(initialWatches);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedWatch, setSelectedWatch] = useState<AdminWatchItem | null>(
    null,
  );
  const [hits, setHits] = useState<
    {
      id: number;
      eventId: number;
      eventTitle: string;
      eventRevision: number;
      hitAt: number;
      summary: string;
      rationale: string;
      status: WatchHitStatus;
    }[]
  >([]);
  const [loadingHits, setLoadingHits] = useState(false);

  // Form states
  const [slug, setSlug] = useState("");
  const [question, setQuestion] = useState("");
  const [criteria, setCriteria] = useState("");
  const [keywords, setKeywords] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    const list = await listWatches();
    setWatches(list);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const kwList = keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);

      await createWatch({
        data: {
          slug: slug.trim(),
          question: question.trim(),
          criteria: criteria.trim(),
          keywords: kwList,
          status: "active",
        },
      });

      setSlug("");
      setQuestion("");
      setCriteria("");
      setKeywords("");
      setIsCreating(false);
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus(w: AdminWatchItem) {
    const nextStatus = w.status === "active" ? "paused" : "active";
    await updateWatch({
      data: {
        id: w.id,
        status: nextStatus,
      },
    });
    await handleRefresh();
  }

  async function handleHitDecision(
    hitId: number,
    decision: "approved" | "rejected",
  ) {
    setActingHitId(hitId);
    setReviewError(null);
    try {
      await decideWatchHitReview({ data: { hitId, decision } });
      await router.invalidate();
    } catch (err) {
      setReviewError(
        err instanceof Error ? err.message : "Failed to submit hit decision",
      );
    } finally {
      setActingHitId(null);
    }
  }

  async function handleViewHits(w: AdminWatchItem) {
    setSelectedWatch(w);
    setLoadingHits(true);
    try {
      const res = await listWatchHits({ data: { watchId: w.id } });
      setHits(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingHits(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 py-2">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground">
            Topic Watches
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Autonomous news monitoring topics. Evaluated against incoming events
            and only triggers when material developments occur.
          </p>
        </div>
        <Button
          onClick={() => setIsCreating(!isCreating)}
          className="font-mono text-xs uppercase"
        >
          {isCreating ? "Cancel" : "+ New Topic Watch"}
        </Button>
      </div>

      {isCreating && (
        <form
          onSubmit={handleCreate}
          className="flex flex-col gap-4 rounded-lg border bg-muted/20 p-5"
        >
          <h2 className="font-mono text-sm font-bold uppercase tracking-wider text-foreground">
            Create New Topic Watch
          </h2>
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 font-mono">
              {error}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-xs font-bold text-foreground">
                Slug (URL Path)
              </label>
              <input
                required
                type="text"
                placeholder="e.g. gpt-5-evaluations"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="rounded border bg-background px-3 py-1.5 text-sm font-mono"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-xs font-bold text-foreground">
                Keywords (comma separated)
              </label>
              <input
                type="text"
                placeholder="e.g. gpt-5, benchmark, evaluation"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                className="rounded border bg-background px-3 py-1.5 text-sm font-mono"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-xs font-bold text-foreground">
              Topic Question
            </label>
            <textarea
              required
              rows={2}
              placeholder="e.g. Tell me when an independent benchmark or evaluation is published for GPT-5."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="rounded border bg-background px-3 py-1.5 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-xs font-bold text-foreground">
              Criteria for Material Progress (Prompted to Jev)
            </label>
            <textarea
              required
              rows={2}
              placeholder="e.g. Must report an empirical third-party evaluation or benchmark suite result, not an opinion piece or company speculation."
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              className="rounded border bg-background px-3 py-1.5 text-sm"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsCreating(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting}
              className="font-mono text-xs uppercase"
            >
              {submitting ? "Creating..." : "Create Watch"}
            </Button>
          </div>
        </form>
      )}

      {/* Pending hits: nothing reaches readers before it is approved */}
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-sm font-bold uppercase tracking-wider text-foreground">
          Pending hits ({pendingHits.length})
        </h2>
        {reviewError && (
          <p role="alert" className="font-mono text-xs text-destructive">
            {reviewError}
          </p>
        )}
        {pendingHits.length === 0 ? (
          <p className="rounded-lg border p-4 font-mono text-xs text-muted-foreground">
            No hits wait for review.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pendingHits.map((h) => (
              <li
                key={h.id}
                className="flex flex-col gap-2 rounded-lg border bg-background p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <p className="font-semibold text-sm text-foreground">
                      {h.watchQuestion}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {h.industryName} ·{" "}
                      <Link
                        to="/e/$eventId"
                        params={{ eventId: String(h.eventId) }}
                        className="underline"
                      >
                        {h.eventTitle}
                      </Link>{" "}
                      · Revision #{h.eventRevision}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={actingHitId === h.id}
                      onClick={() => handleHitDecision(h.id, "approved")}
                      className="font-mono text-xs"
                    >
                      {actingHitId === h.id ? "Saving..." : "Approve"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actingHitId === h.id}
                      onClick={() => handleHitDecision(h.id, "rejected")}
                      className="font-mono text-xs"
                    >
                      Reject
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-foreground">{h.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Watches List */}
      <div className="overflow-x-auto rounded-lg border">
        <table className={`w-full text-left text-xs ${ADMIN_TABLE}`}>
          <thead className="border-b bg-muted/50 font-mono uppercase text-muted-foreground">
            <tr>
              <th className="p-3">ID / Slug</th>
              <th className="p-3">Question</th>
              <th className="p-3">Criteria</th>
              <th className="p-3">Keywords</th>
              <th className="p-3">Status</th>
              <th className="p-3">Hits</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y font-sans">
            {watches.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="p-6 text-center text-muted-foreground font-mono"
                >
                  No watches configured yet.
                </td>
              </tr>
            ) : (
              watches.map((w) => (
                <tr key={w.id} className="hover:bg-muted/30">
                  <td className="p-3 font-mono font-medium whitespace-nowrap">
                    <div>#{w.id}</div>
                    <a
                      href={`/w/${w.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sec-ink underline font-bold"
                    >
                      /w/{w.slug}
                    </a>
                  </td>
                  <td className="p-3 max-w-[280px]">
                    <p className="font-semibold text-foreground line-clamp-2">
                      {w.question}
                    </p>
                  </td>
                  <td className="p-3 max-w-[240px] text-muted-foreground">
                    <p className="line-clamp-2">{w.criteria}</p>
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1 max-w-[160px]">
                      {w.keywords.map((kw, idx) => (
                        <span
                          key={idx}
                          className="rounded border bg-background px-1.5 py-0.5 text-[10px] font-mono"
                        >
                          {kw}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                        w.status === "active"
                          ? "bg-emerald-500/10 text-emerald-600"
                          : "bg-amber-500/10 text-amber-600"
                      }`}
                    >
                      {w.status}
                    </span>
                  </td>
                  <td className="p-3 font-mono whitespace-nowrap font-bold">
                    {w.hitCount}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleViewHits(w)}
                        className="font-mono text-[11px]"
                      >
                        Hits ({w.hitCount})
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleToggleStatus(w)}
                        className="font-mono text-[11px]"
                      >
                        {w.status === "active" ? "Pause" : "Activate"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Selected Watch Hits Modal / Section */}
      {selectedWatch && (
        <div className="flex flex-col gap-4 rounded-lg border bg-muted/10 p-5 mt-4">
          <div className="flex items-center justify-between border-b pb-3">
            <div>
              <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-foreground">
                Hits for Watch: {selectedWatch.question}
              </h3>
              <p className="font-mono text-xs text-muted-foreground">
                Slug: /w/{selectedWatch.slug} | Total Hits: {hits.length}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelectedWatch(null)}
              className="font-mono text-xs"
            >
              Close
            </Button>
          </div>

          {loadingHits ? (
            <div className="py-8 text-center font-mono text-xs text-muted-foreground">
              Loading hits...
            </div>
          ) : hits.length === 0 ? (
            <div className="py-8 text-center font-mono text-xs text-muted-foreground">
              No hits recorded for this watch yet.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {hits.map((h) => (
                <div
                  key={h.id}
                  className="rounded border bg-background p-4 flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between text-xs font-mono text-muted-foreground border-b pb-1.5">
                    <span className="font-bold text-foreground">
                      Hit #{h.id} • Revision #{h.eventRevision} •{" "}
                      <span className="uppercase">
                        {h.status.replace("_", " ")}
                      </span>
                    </span>
                    <span>{new Date(h.hitAt).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="font-mono text-[11px] font-bold text-muted-foreground uppercase">
                      What's New:
                    </span>
                    <p className="font-medium text-sm text-foreground mt-0.5">
                      {h.summary}
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono font-bold">
                      Event #{h.eventId}:{" "}
                    </span>
                    <span>{h.eventTitle}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
