import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  changeArticleIndustry,
  createCorrection,
  getArticle,
  reanalyzeArticle,
  updateArticleOverride,
} from "../../../server/admin/articles";
import { listIndustries } from "../../../server/admin/industries";
import { decideReview } from "../../../server/admin/review";
import {
  TakedownPanel,
  currentDecision,
} from "../../../components/admin/RemoveButton";

export const Route = createFileRoute("/admin/articles/$articleId")({
  ssr: "data-only",
  loader: async ({ params }) => {
    const id = Number(params.articleId);
    const [data, industries] = await Promise.all([
      getArticle({ data: id }),
      listIndustries(),
    ]);
    if (!data) {
      throw new Response("Article not found", { status: 404 });
    }
    return { data, industries };
  },
  component: AdminArticleDetailPage,
});

function AdminArticleDetailPage() {
  const { data, industries } = Route.useLoaderData();
  const { article, reviews, analyses, corrections } = data;
  const router = useRouter();

  const [titleOverride, setTitleOverride] = useState(
    article.titleOverride ?? "",
  );
  const [summaryOverride, setSummaryOverride] = useState(
    article.summaryOverride ?? "",
  );
  const [targetIndustryId, setTargetIndustryId] = useState<number>(
    article.industryId,
  );
  const [correctionText, setCorrectionText] = useState("");

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function handleSaveOverrides(e: React.FormEvent) {
    e.preventDefault();
    setWorking(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await updateArticleOverride({
        data: {
          articleId: article.id,
          titleOverride,
          summaryOverride,
        },
      });
      setStatusMessage("Overrides saved (empty strings stored as NULL).");
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to update overrides",
      );
    } finally {
      setWorking(false);
    }
  }

  async function handleChangeSection(e: React.FormEvent) {
    e.preventDefault();
    if (targetIndustryId === article.industryId) return;
    setWorking(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await changeArticleIndustry({
        data: {
          articleId: article.id,
          industryId: targetIndustryId,
        },
      });
      setStatusMessage("Section changed successfully.");
      await router.invalidate();
    } catch (err) {
      if (err instanceof Response && err.status === 409) {
        setErrorMessage(
          "Conflict: Article is part of an event timeline and cannot be moved across sections.",
        );
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : "Failed to change section",
        );
      }
    } finally {
      setWorking(false);
    }
  }

  // #87 A3b: Remove from site = reject the current body; Restore = approve
  // it again. Same server function as the review queue.
  async function handleTakedown(decision: "approved" | "rejected") {
    if (!article.bodySha) return;
    setWorking(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await decideReview({
        data: { articleId: article.id, bodySha: article.bodySha, decision },
      });
      setStatusMessage(
        decision === "rejected"
          ? "Article removed from the public site."
          : "Article restored to the public site.",
      );
    } catch (err) {
      if (err instanceof Response && err.status === 409) {
        setErrorMessage(
          "Conflict: the article body changed since this page loaded. The page has been refreshed; check the article and try again.",
        );
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : "Failed to record the decision",
        );
      }
    } finally {
      setWorking(false);
      await router.invalidate();
    }
  }

  async function handleReanalyze() {
    setWorking(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await reanalyzeArticle({
        data: { articleId: article.id, expectedStage: article.stage },
      });
      setStatusMessage(
        "Article reset to body_ready for reanalysis. Earlier analyses and ledger rows are kept.",
      );
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to reanalyze",
      );
    } finally {
      setWorking(false);
    }
  }

  async function handleAddCorrection(e: React.FormEvent) {
    e.preventDefault();
    if (!correctionText.trim()) return;
    setWorking(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await createCorrection({
        data: {
          targetType: "articles",
          targetId: article.id,
          body: correctionText.trim(),
        },
      });
      setCorrectionText("");
      setStatusMessage("Correction published.");
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to publish correction",
      );
    } finally {
      setWorking(false);
    }
  }

  const decision = currentDecision(reviews, article.bodySha);

  return (
    <div className="flex max-w-4xl flex-col gap-8 pb-12">
      <div>
        <Link
          to="/admin/review"
          className="text-xs text-muted-foreground hover:underline"
        >
          &larr; Back to Review Queue
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="font-mono text-xs text-muted-foreground">
              Article #{article.id} · Stage: {article.stage}
            </span>
            <h1 className="text-xl font-bold tracking-tight">
              {article.title}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={working}
              onClick={handleReanalyze}
              className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              Reanalyze Article
            </button>
          </div>
        </div>
      </div>

      {statusMessage && (
        <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <TakedownPanel
        decision={decision}
        working={working}
        onRemove={() => handleTakedown("rejected")}
        onRestore={() => handleTakedown("approved")}
      />

      {/* Overrides form */}
      <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Editorial Overrides</h2>
        <p className="text-xs text-muted-foreground">
          Clear the fields (or leave blank) to revert to the automated AI title
          and summary.
        </p>

        <form onSubmit={handleSaveOverrides} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="titleOverride"
              className="text-xs font-medium text-muted-foreground"
            >
              Title Override
            </label>
            <input
              id="titleOverride"
              type="text"
              value={titleOverride}
              onChange={(e) => setTitleOverride(e.target.value)}
              placeholder="Custom headline override..."
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="summaryOverride"
              className="text-xs font-medium text-muted-foreground"
            >
              Summary Override
            </label>
            <textarea
              id="summaryOverride"
              rows={4}
              value={summaryOverride}
              onChange={(e) => setSummaryOverride(e.target.value)}
              placeholder="Custom summary override..."
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <button
              type="submit"
              disabled={working}
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Save Overrides
            </button>
          </div>
        </form>
      </section>

      {/* Change section */}
      <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Change Section</h2>
        <form
          onSubmit={handleChangeSection}
          className="flex flex-wrap items-center gap-3"
        >
          <select
            value={targetIndustryId}
            onChange={(e) => setTargetIndustryId(Number(e.target.value))}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            {industries.map((ind) => (
              <option key={ind.id} value={ind.id}>
                {ind.name} ({ind.slug})
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={working || targetIndustryId === article.industryId}
            className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            Move Section
          </button>
        </form>
      </section>

      {/* Public Corrections */}
      <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Public Corrections</h2>
        <p className="text-xs text-muted-foreground">
          Corrections appear publicly alongside the article card once approved.
        </p>

        {corrections.length > 0 && (
          <div className="flex flex-col gap-2 divide-y border rounded-md p-3">
            {corrections.map((c) => (
              <div key={c.id} className="pt-2 first:pt-0">
                <p className="text-xs">{c.body}</p>
                <span className="font-mono text-[0.65rem] text-muted-foreground">
                  {new Date(c.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleAddCorrection} className="flex flex-col gap-2">
          <textarea
            rows={2}
            value={correctionText}
            onChange={(e) => setCorrectionText(e.target.value)}
            placeholder="Add a publicly visible correction note..."
            className="rounded-md border bg-background px-3 py-2 text-xs"
          />
          <div>
            <button
              type="submit"
              disabled={working || !correctionText.trim()}
              className="rounded border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              Post Correction
            </button>
          </div>
        </form>
      </section>

      {/* Review History */}
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Review Decision History</h2>
        {reviews.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No reviews recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto text-xs">
            <table className="w-full text-left">
              <thead className="border-b uppercase text-muted-foreground">
                <tr>
                  <th className="py-2">Decision</th>
                  <th className="py-2">Reviewer</th>
                  <th className="py-2">Body SHA</th>
                  <th className="py-2">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {reviews.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 font-bold uppercase">{r.decision}</td>
                    <td className="py-2">{r.reviewer}</td>
                    <td className="py-2 font-mono text-[0.7rem]">
                      {r.bodySha?.slice(0, 10)}...
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Analysis History */}
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Analysis History</h2>
        {analyses.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No analyses recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto text-xs">
            <table className="w-full text-left">
              <thead className="border-b uppercase text-muted-foreground">
                <tr>
                  <th className="py-2">Score</th>
                  <th className="py-2">Selected</th>
                  <th className="py-2">Prompt Version</th>
                  <th className="py-2">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {analyses.map((an) => (
                  <tr key={an.id}>
                    <td className="py-2 font-mono">{an.totalScore}</td>
                    <td className="py-2">{an.selected ? "Yes" : "No"}</td>
                    <td className="py-2 font-mono text-[0.7rem]">
                      {an.promptVersion}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {new Date(an.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
