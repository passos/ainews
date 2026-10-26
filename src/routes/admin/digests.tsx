import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  approveDigestCopy,
  listAdminDigests,
  publishDigest,
} from "../../server/admin/digests";

export const Route = createFileRoute("/admin/digests")({
  ssr: "data-only",
  loader: async () => listAdminDigests(),
  component: AdminDigestsPage,
});

function AdminDigestsPage() {
  const { pending, published } = Route.useLoaderData();
  const router = useRouter();
  const [publishingId, setPublishingId] = useState<number | null>(null);
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handlePublish(digestId: number) {
    setPublishingId(digestId);
    setErrorMessage(null);
    try {
      await publishDigest({ data: { digestId } });
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to publish digest",
      );
    } finally {
      setPublishingId(null);
    }
  }

  async function handleApproveCopy(digestId: number) {
    setApprovingId(digestId);
    setErrorMessage(null);
    try {
      await approveDigestCopy({ data: { digestId } });
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to approve digest copy",
      );
    } finally {
      setApprovingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="font-serif text-2xl font-bold tracking-tight">
          Daily Digests
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Review generated daily briefings before publication or browse
          published editions.
        </p>
      </div>

      {errorMessage && (
        <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive font-mono">
          {errorMessage}
        </div>
      )}

      {/* Pending Approval Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h3 className="font-mono text-sm font-bold uppercase tracking-wider">
            Pending Review ({pending.length})
          </h3>
          {pending.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
              Needs Approval
            </span>
          )}
        </div>

        {pending.length === 0 ? (
          <p className="border-2 border-dashed px-4 py-6 font-mono text-xs uppercase tracking-wider text-muted-foreground rounded-md">
            No daily digests currently waiting for review.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {pending.map((d) => (
              <div
                key={d.id}
                className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-base">
                      {d.industryName}
                    </span>
                    <span className="rounded bg-sec/10 text-sec-ink px-1.5 py-0.5 font-mono text-[0.7rem] uppercase font-bold">
                      {d.kind}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      · {d.periodStart}
                    </span>
                    <span className="rounded bg-muted px-2 py-0.5 font-mono text-[0.7rem]">
                      {d.itemCount} items
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {d.hasCopy && d.copyApprovedAt === null ? (
                      <button
                        type="button"
                        disabled={approvingId === d.id}
                        onClick={() => handleApproveCopy(d.id)}
                        className="rounded border px-3 py-1 font-mono text-xs font-semibold shadow-xs hover:bg-muted disabled:opacity-50 cursor-pointer"
                      >
                        {approvingId === d.id
                          ? "Approving..."
                          : "Approve intro & one-liners"}
                      </button>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">
                        {d.hasCopy ? "Copy: approved" : "Copy: none"}
                      </span>
                    )}
                    {d.publishedAt === null ? (
                      <button
                        type="button"
                        disabled={publishingId === d.id}
                        onClick={() => handlePublish(d.id)}
                        className="rounded bg-primary px-3 py-1 font-mono text-xs font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
                      >
                        {publishingId === d.id
                          ? "Publishing..."
                          : "Publish to Site & RSS"}
                      </button>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">
                        Published
                      </span>
                    )}
                  </div>
                </div>

                {d.intro && (
                  <p className="text-sm text-foreground/90 bg-muted/30 p-2.5 rounded text-left">
                    <span className="font-mono text-xs font-bold text-muted-foreground block mb-1">
                      Synthesis:
                    </span>
                    {d.intro}
                  </p>
                )}

                {d.items && d.items.length > 0 && (
                  <div className="flex flex-col gap-2 pt-2 border-t">
                    <span className="font-mono text-xs font-bold text-muted-foreground uppercase tracking-wider">
                      Stories Preview ({d.items.length}):
                    </span>
                    <ul className="flex flex-col gap-2">
                      {d.items.map((item) => (
                        <li
                          key={item.eventId}
                          className="rounded-md border bg-muted/20 p-3 text-xs flex flex-col gap-1"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-sm text-foreground">
                              {item.title}
                            </span>
                            <span className="font-mono text-[0.7rem] text-muted-foreground shrink-0 rounded bg-muted px-1.5 py-0.5">
                              {item.sourceName}
                            </span>
                          </div>
                          <p className="text-foreground/80 leading-relaxed">
                            {item.summary || "—"}
                          </p>
                          {item.oneLiner && (
                            <p className="text-foreground/80 leading-relaxed">
                              Model one-liner: {item.oneLiner}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex items-center justify-between font-mono text-xs text-muted-foreground pt-1">
                  <span>
                    Generated: {new Date(d.createdAt).toLocaleString()}
                  </span>
                  <span>Email: {d.emailedAt ? "Sent" : "Pending/Off"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Published Section */}
      <section className="flex flex-col gap-4">
        <h3 className="font-mono text-sm font-bold uppercase tracking-wider">
          Published Digests ({published.length})
        </h3>

        {published.length === 0 ? (
          <p className="border-2 border-dashed px-4 py-6 font-mono text-xs uppercase tracking-wider text-muted-foreground rounded-md">
            No published digests yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="p-3">Section</th>
                  <th className="p-3">Kind</th>
                  <th className="p-3">Date</th>
                  <th className="p-3">Items</th>
                  <th className="p-3">Published At</th>
                  <th className="p-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y font-mono text-xs">
                {published.map((d) => (
                  <tr key={d.id} className="hover:bg-muted/20">
                    <td className="p-3 font-semibold text-foreground">
                      {d.industryName}
                    </td>
                    <td className="p-3">
                      <span className="rounded bg-sec/10 text-sec-ink px-1.5 py-0.5 font-mono text-[0.7rem] uppercase font-bold">
                        {d.kind}
                      </span>
                    </td>
                    <td className="p-3">{d.periodStart}</td>
                    <td className="p-3">{d.itemCount}</td>
                    <td className="p-3 text-muted-foreground">
                      {d.publishedAt
                        ? new Date(d.publishedAt).toLocaleString()
                        : "—"}
                    </td>
                    <td className="p-3">
                      <Link
                        to="/digest/$section/$date"
                        params={{
                          section: d.industrySlug,
                          date: d.periodStart,
                        }}
                        search={{ kind: d.kind }}
                        className="text-primary underline hover:text-primary/80 font-sans text-xs"
                      >
                        View Public Page ↗
                      </Link>
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
