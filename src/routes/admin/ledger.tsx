import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  getBudgetSummary,
  listLedgerCalls,
  reconcileUnknownCall,
  updateDailyCap,
} from "../../server/admin/ledger";

export const Route = createFileRoute("/admin/ledger")({
  ssr: "data-only",
  loader: async () => {
    const [budgetSummary, initialCalls] = await Promise.all([
      getBudgetSummary(),
      listLedgerCalls(),
    ]);
    return { budgetSummary, initialCalls };
  },
  component: AdminLedgerPage,
});

function AdminLedgerPage() {
  const { budgetSummary, initialCalls } = Route.useLoaderData();
  const router = useRouter();

  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState<number>(1);
  const [displayedCalls, setDisplayedCalls] = useState(initialCalls);
  const [loadingCalls, setLoadingCalls] = useState(false);

  const [editingCapChannel, setEditingCapChannel] = useState<
    "workers_ai" | "gateway" | "jina" | null
  >(null);
  const [newCapUsd, setNewCapUsd] = useState<string>("");

  const [reconcilingCallId, setReconcilingCallId] = useState<number | null>(
    null,
  );
  const [reconcileStatus, setReconcileStatus] = useState<
    "completed" | "failed"
  >("completed");
  const [reconcileCostUsd, setReconcileCostUsd] = useState<string>("0.00");

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const channels: Array<"workers_ai" | "gateway" | "jina"> = [
    "gateway",
    "workers_ai",
    "jina",
  ];

  async function fetchCalls(channel: string, status: string, newPage: number) {
    setLoadingCalls(true);
    try {
      const res = await listLedgerCalls({
        data: {
          channel: channel === "all" ? undefined : channel,
          status: status === "all" ? undefined : status,
          page: newPage,
        },
      });
      setDisplayedCalls(res);
      setPage(newPage);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load ledger calls",
      );
    } finally {
      setLoadingCalls(false);
    }
  }

  async function handleFilterChange(newChannel: string, newStatus: string) {
    setChannelFilter(newChannel);
    setStatusFilter(newStatus);
    await fetchCalls(newChannel, newStatus, 1);
  }

  async function handleUpdateCap(channel: "workers_ai" | "gateway" | "jina") {
    const val = parseFloat(newCapUsd);
    if (isNaN(val) || val < 0) {
      setError("Please enter a valid dollar amount");
      return;
    }
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const capMicros = Math.round(val * 1_000_000);
      await updateDailyCap({
        data: { channel, capMicros },
      });
      setMessage(`Updated cap for ${channel} to $${val.toFixed(2)}.`);
      setEditingCapChannel(null);
      await router.invalidate();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update daily cap",
      );
    } finally {
      setWorking(false);
    }
  }

  async function handleReconcile(callId: number) {
    const cost = parseFloat(reconcileCostUsd);
    if (isNaN(cost) || cost < 0) {
      setError("Please enter a valid dollar amount for actual cost");
      return;
    }
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const costMicros = Math.round(cost * 1_000_000);
      await reconcileUnknownCall({
        data: {
          callId,
          status: reconcileStatus,
          costMicros,
        },
      });
      setMessage(`Call #${callId} reconciled successfully.`);
      setReconcilingCallId(null);
      await router.invalidate();
      await fetchCalls(channelFilter, statusFilter, page);
    } catch (err) {
      if (err instanceof Response && err.status === 409) {
        setError(
          "Conflict: Call was already reconciled or is no longer in unknown status.",
        );
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to reconcile call",
        );
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-8 pb-12">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Ledger & Budgets</h1>
        <p className="text-sm text-muted-foreground">
          Monitor daily AI spend against safety caps and reconcile ambiguous
          ledger transactions.
        </p>
      </div>

      {message && (
        <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
          {message}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Budget Summary Cards */}
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">
          Daily Budget Caps ({budgetSummary.day})
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {channels.map((ch) => {
            const b = budgetSummary.budgets.find((row) => row.channel === ch);
            const capMicros =
              (budgetSummary.caps as Record<string, number>)[ch] ??
              b?.capMicros ??
              0;
            const spentMicros = b?.spentMicros ?? 0;
            const reservedMicros = b?.reservedMicros ?? 0;

            const isEditing = editingCapChannel === ch;

            return (
              <div
                key={ch}
                className="flex flex-col justify-between rounded-lg border bg-card p-4 gap-3"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs uppercase font-bold">
                      {ch}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingCapChannel(isEditing ? null : ch);
                        setNewCapUsd((capMicros / 1_000_000).toFixed(2));
                      }}
                      className="text-xs text-primary hover:underline"
                    >
                      {isEditing ? "Cancel" : "Edit Cap"}
                    </button>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-2xl font-black">
                      ${(spentMicros / 1_000_000).toFixed(4)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      / ${(capMicros / 1_000_000).toFixed(2)} cap
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Reserved: ${(reservedMicros / 1_000_000).toFixed(4)}
                  </p>
                </div>

                {isEditing && (
                  <div className="flex items-center gap-2 border-t pt-3">
                    <span className="text-xs font-mono">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newCapUsd}
                      onChange={(e) => setNewCapUsd(e.target.value)}
                      className="w-24 rounded border px-2 py-1 text-xs font-mono"
                    />
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => handleUpdateCap(ch)}
                      className="rounded bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Ledger Calls Table */}
      <section className="flex flex-col gap-4 border-t pt-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">LLM Call Ledger</h2>
            <p className="text-xs text-muted-foreground">
              Audit log of all model and reader invocations.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <select
              value={channelFilter}
              onChange={(e) => handleFilterChange(e.target.value, statusFilter)}
              className="rounded border bg-background px-2.5 py-1"
            >
              <option value="all">All Channels</option>
              <option value="gateway">gateway</option>
              <option value="workers_ai">workers_ai</option>
              <option value="jina">jina</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) =>
                handleFilterChange(channelFilter, e.target.value)
              }
              className="rounded border bg-background px-2.5 py-1"
            >
              <option value="all">All Statuses</option>
              <option value="unknown">unknown (ambiguous)</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-xs">
            <thead className="border-b bg-muted/50 uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5">ID</th>
                <th className="px-3 py-2.5">Slot / Model</th>
                <th className="px-3 py-2.5">Channel</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Cost</th>
                <th className="px-3 py-2.5">Duration</th>
                <th className="px-3 py-2.5">Time</th>
                <th className="px-3 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loadingCalls ? (
                <tr>
                  <td
                    colSpan={8}
                    className="p-4 text-center text-muted-foreground"
                  >
                    Loading ledger calls...
                  </td>
                </tr>
              ) : displayedCalls.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="p-4 text-center text-muted-foreground"
                  >
                    No ledger transactions match this filter.
                  </td>
                </tr>
              ) : (
                displayedCalls.map((c) => {
                  const isReconciling = reconcilingCallId === c.id;
                  return (
                    <tr key={c.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2.5 font-mono">#{c.id}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col">
                          <span className="font-semibold">{c.slot}</span>
                          <span className="font-mono text-[0.65rem] text-muted-foreground">
                            {c.model}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono">{c.channel}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[0.65rem] font-bold uppercase ${
                            c.status === "completed"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : c.status === "unknown"
                                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 font-black animate-pulse"
                                : "bg-destructive/10 text-destructive"
                          }`}
                        >
                          {c.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono">
                        ${((c.costMicros ?? 0) / 1_000_000).toFixed(4)}
                      </td>
                      <td className="px-3 py-2.5 font-mono">
                        {c.sentAt && c.updatedAt > c.sentAt
                          ? `${c.updatedAt - c.sentAt}ms`
                          : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {new Date(c.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {c.status === "unknown" && (
                          <button
                            type="button"
                            onClick={() => {
                              setReconcilingCallId(isReconciling ? null : c.id);
                              setReconcileStatus("completed");
                              setReconcileCostUsd(
                                ((c.estimatedMicros ?? 0) / 1_000_000).toFixed(
                                  4,
                                ),
                              );
                            }}
                            className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[0.7rem] font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
                          >
                            {isReconciling ? "Close" : "Reconcile"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {page}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || loadingCalls}
              onClick={() => fetchCalls(channelFilter, statusFilter, page - 1)}
              className="rounded border px-2 py-1 disabled:opacity-50"
            >
              &larr; Previous
            </button>
            <button
              type="button"
              disabled={displayedCalls.length < 50 || loadingCalls}
              onClick={() => fetchCalls(channelFilter, statusFilter, page + 1)}
              className="rounded border px-2 py-1 disabled:opacity-50"
            >
              Next &rarr;
            </button>
          </div>
        </div>

        {/* Inline Reconcile Form */}
        {reconcilingCallId !== null && (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-xs">
            <h3 className="font-semibold text-amber-600 dark:text-amber-400">
              Reconcile Unknown Transaction #{reconcilingCallId}
            </h3>
            <p className="text-muted-foreground">
              Mark whether the LLM call completed or failed, and record the
              actual billable cost.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label htmlFor="reconcileStatus" className="font-medium">
                  Outcome:
                </label>
                <select
                  id="reconcileStatus"
                  value={reconcileStatus}
                  onChange={(e) =>
                    setReconcileStatus(e.target.value as "completed" | "failed")
                  }
                  className="rounded border bg-background px-2 py-1"
                >
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="reconcileCost" className="font-medium">
                  Actual Cost ($):
                </label>
                <input
                  id="reconcileCost"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={reconcileCostUsd}
                  onChange={(e) => setReconcileCostUsd(e.target.value)}
                  className="w-24 rounded border bg-background px-2 py-1 font-mono"
                />
              </div>

              <button
                type="button"
                disabled={working}
                onClick={() => handleReconcile(reconcilingCallId)}
                className="rounded bg-amber-600 px-3 py-1 font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                Confirm Reconciliation
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
