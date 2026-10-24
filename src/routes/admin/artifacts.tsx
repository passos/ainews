import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { formatUtc } from "../../lib/time";
import {
  decideArtifactReview,
  listPendingArtifacts,
} from "../../server/admin/artifacts";

export const Route = createFileRoute("/admin/artifacts")({
  ssr: "data-only",
  loader: async () => listPendingArtifacts(),
  component: AdminArtifactsPage,
});

function AdminArtifactsPage() {
  const artifacts = Route.useLoaderData();
  const router = useRouter();
  const [actingId, setActingId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleDecision(
    artifactId: number,
    decision: "approved" | "rejected",
    expectedRevision: number,
  ) {
    setActingId(artifactId);
    setErrorMessage(null);
    try {
      await decideArtifactReview({
        data: {
          artifactId,
          decision,
          expectedRevision,
        },
      });
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to submit artifact decision",
      );
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="font-serif text-2xl font-bold tracking-tight">
          Artifacts Review Queue
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review generated editorial artifacts (Briefs, audience explanations,
          and paper decoders) before publication.
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
            Pending Review ({artifacts.length})
          </h3>
          {artifacts.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
              Needs Approval
            </span>
          )}
        </div>

        {artifacts.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            No artifacts currently waiting for review.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {artifacts.map((a) => {
              const parsedContent: unknown = (() => {
                try {
                  return JSON.parse(a.content);
                } catch {
                  return a.content;
                }
              })();

              return (
                <div
                  key={a.id}
                  className="flex flex-col gap-3 rounded-lg border bg-card p-5 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-sec/15 px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-wider text-sec-ink">
                          {a.industryName}
                        </span>
                        <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                          {a.type}
                          {a.audience ? ` · ${a.audience}` : ""}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          rev {a.inputRevision}
                        </span>
                      </div>
                      <h4 className="mt-1.5 font-serif text-lg font-bold leading-snug">
                        {a.eventTitle}
                      </h4>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        Generated {formatUtc(a.createdAt)} using {a.model}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={actingId === a.id}
                        onClick={() =>
                          handleDecision(a.id, "approved", a.inputRevision)
                        }
                        className="rounded-md bg-emerald-600 px-3 py-1.5 font-mono text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {actingId === a.id ? "Saving..." : "Approve"}
                      </button>
                      <button
                        type="button"
                        disabled={actingId === a.id}
                        onClick={() =>
                          handleDecision(a.id, "rejected", a.inputRevision)
                        }
                        className="rounded-md border border-destructive/40 bg-transparent px-3 py-1.5 font-mono text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>

                  <div className="rounded bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap">
                      {typeof parsedContent === "object"
                        ? JSON.stringify(parsedContent, null, 2)
                        : String(parsedContent)}
                    </pre>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
