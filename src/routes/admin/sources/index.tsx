import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { listIndustries } from "../../../server/admin/industries";
import {
  approveCandidate,
  deleteSource,
  listSourceCandidates,
  listSources,
  rejectCandidate,
  resumeSource,
  triggerCollect,
  triggerDiscovery,
} from "../../../server/admin/sources";

export const Route = createFileRoute("/admin/sources/")({
  ssr: "data-only",
  loader: async () => {
    const [sources, industries, candidates] = await Promise.all([
      listSources(),
      listIndustries(),
      listSourceCandidates(),
    ]);
    return { sources, industries, candidates };
  },
  component: AdminSourcesPage,
});

function AdminSourcesPage() {
  const { sources, industries, candidates } = Route.useLoaderData();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<"sources" | "candidates">(
    "sources",
  );
  const [selectedIndustry, setSelectedIndustry] = useState<number | "all">(
    "all",
  );
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [selectedCandidateStatus, setSelectedCandidateStatus] =
    useState<string>("all");
  const [actingId, setActingId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [triggeringIndustryId, setTriggeringIndustryId] = useState<
    number | null
  >(null);

  const filteredSources = sources.filter((s) => {
    if (selectedIndustry !== "all" && s.industryId !== selectedIndustry) {
      return false;
    }
    if (selectedStatus !== "all" && s.status !== selectedStatus) {
      return false;
    }
    return true;
  });

  const filteredCandidates = candidates.filter((c) => {
    if (selectedIndustry !== "all" && c.industryId !== selectedIndustry) {
      return false;
    }
    if (
      selectedCandidateStatus !== "all" &&
      c.status !== selectedCandidateStatus
    ) {
      return false;
    }
    return true;
  });

  async function handleResume(id: number) {
    setActingId(id);
    setMessage(null);
    try {
      await resumeSource({ data: id });
      setMessage(`Source #${id} resumed successfully.`);
      await router.invalidate();
    } catch (err) {
      setMessage(`Failed to resume source: ${String(err)}`);
    } finally {
      setActingId(null);
    }
  }

  async function handleTrigger(id: number) {
    setActingId(id);
    setMessage(null);
    try {
      await triggerCollect({ data: id });
      setMessage(`Enqueued immediate fetch for source #${id}.`);
    } catch (err) {
      setMessage(`Failed to trigger fetch: ${String(err)}`);
    } finally {
      setActingId(null);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm(`Are you sure you want to delete source #${id}?`)) return;
    setActingId(id);
    setMessage(null);
    try {
      await deleteSource({ data: id });
      setMessage(`Source #${id} deleted.`);
      await router.invalidate();
    } catch (err) {
      setMessage(`Failed to delete source: ${String(err)}`);
    } finally {
      setActingId(null);
    }
  }

  async function handleApproveCandidate(id: number) {
    setActingId(id);
    setMessage(null);
    try {
      await approveCandidate({ data: id });
      setMessage(`Candidate #${id} approved and activated.`);
      await router.invalidate();
    } catch (err) {
      setMessage(`Failed to approve candidate: ${String(err)}`);
    } finally {
      setActingId(null);
    }
  }

  async function handleRejectCandidate(id: number) {
    const reason = prompt("Rejection reason (optional):", "rejected_by_admin");
    if (reason === null) return;
    setActingId(id);
    setMessage(null);
    try {
      await rejectCandidate({ data: { id, reason } });
      setMessage(`Candidate #${id} rejected.`);
      await router.invalidate();
    } catch (err) {
      setMessage(`Failed to reject candidate: ${String(err)}`);
    } finally {
      setActingId(null);
    }
  }

  async function handleTriggerDiscovery() {
    const targetIndustry =
      selectedIndustry !== "all" ? selectedIndustry : industries[0]?.id;
    if (!targetIndustry) {
      setMessage("Please select an industry first.");
      return;
    }
    setTriggeringIndustryId(targetIndustry);
    setMessage(null);
    try {
      const res = await triggerDiscovery({
        data: { industryId: targetIndustry },
      });
      setMessage(
        `Discovery job enqueued (Run #${res.runId}). Results will appear in candidates.`,
      );
      await router.invalidate();
    } catch (err) {
      setMessage(`Discovery trigger failed: ${String(err)}`);
    } finally {
      setTriggeringIndustryId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            Sources & Candidates
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage active feeds, inspect crawler health, and discover new
            candidate sources.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === "candidates" && (
            <button
              type="button"
              disabled={triggeringIndustryId !== null}
              onClick={handleTriggerDiscovery}
              className="rounded bg-secondary px-3 py-1.5 text-xs font-semibold hover:bg-secondary/80 disabled:opacity-50"
            >
              {triggeringIndustryId !== null
                ? "Triggering..."
                : "⚡ Trigger Discovery"}
            </button>
          )}
          <Link
            to="/admin/sources/$sourceId"
            params={{ sourceId: "new" }}
            className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
          >
            + Add Source
          </Link>
        </div>
      </div>

      {message && (
        <div className="rounded-md border p-3 text-sm bg-muted/40">
          {message}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b text-sm">
        <button
          type="button"
          onClick={() => setActiveTab("sources")}
          className={`px-4 py-2 font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "sources"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Active Sources ({sources.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("candidates")}
          className={`px-4 py-2 font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "candidates"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Discovered Candidates ({candidates.length})
        </button>
      </div>

      {activeTab === "sources" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <select
              value={selectedIndustry}
              onChange={(e) =>
                setSelectedIndustry(
                  e.target.value === "all" ? "all" : Number(e.target.value),
                )
              }
              className="rounded border px-2.5 py-1 text-xs"
            >
              <option value="all">All Sections</option>
              {industries.map((ind) => (
                <option key={ind.id} value={ind.id}>
                  {ind.name}
                </option>
              ))}
            </select>

            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="rounded border px-2.5 py-1 text-xs"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="candidate">Candidate</option>
            </select>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="border-b bg-muted/50 uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5">ID</th>
                  <th className="px-3 py-2.5">Name / URL</th>
                  <th className="px-3 py-2.5">Section</th>
                  <th className="px-3 py-2.5">Kind</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Rung</th>
                  <th className="px-3 py-2.5">Fails</th>
                  <th className="px-3 py-2.5">Last OK</th>
                  <th className="px-3 py-2.5">Jina</th>
                  <th className="px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredSources.map((s) => (
                  <tr key={s.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2.5 font-mono text-[0.7rem] text-muted-foreground">
                      {s.id}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-foreground">
                        {s.name || "(unnamed)"}
                      </div>
                      <div className="font-mono text-[0.7rem] text-muted-foreground truncate max-w-xs">
                        {s.feedUrl}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {industries.find((i) => i.id === s.industryId)?.name ??
                        `#${s.industryId}`}
                    </td>
                    <td className="px-3 py-2.5 uppercase font-mono text-[0.7rem]">
                      {s.kind}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[0.7rem] font-semibold ${
                          s.status === "active"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : s.status === "paused"
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                              : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        }`}
                      >
                        {s.status}
                        {s.pausedReason ? ` (${s.pausedReason})` : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[0.7rem]">
                      {s.fetchRung ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[0.7rem]">
                      {s.failCount > 0 ? (
                        <span className="text-destructive font-semibold">
                          {s.failCount}
                        </span>
                      ) : (
                        "0"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {s.lastOkAt
                        ? new Date(s.lastOkAt).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      {s.jinaEnabled ? (
                        <span className="text-emerald-500 font-semibold">
                          ON
                        </span>
                      ) : (
                        <span className="text-muted-foreground">OFF</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {s.status === "paused" && (
                          <button
                            type="button"
                            disabled={actingId === s.id}
                            onClick={() => handleResume(s.id)}
                            className="rounded bg-emerald-600 px-2 py-0.5 text-[0.7rem] font-semibold text-white hover:bg-emerald-700"
                          >
                            Resume
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={actingId === s.id}
                          onClick={() => handleTrigger(s.id)}
                          className="rounded border px-2 py-0.5 text-[0.7rem] hover:bg-muted"
                        >
                          Fetch Now
                        </button>
                        <Link
                          to="/admin/sources/$sourceId"
                          params={{ sourceId: String(s.id) }}
                          className="rounded border px-2 py-0.5 text-[0.7rem] hover:bg-muted"
                        >
                          Edit
                        </Link>
                        <button
                          type="button"
                          disabled={actingId === s.id}
                          onClick={() => handleDelete(s.id)}
                          className="rounded border border-destructive/40 px-2 py-0.5 text-[0.7rem] text-destructive hover:bg-destructive/10"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "candidates" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <select
              value={selectedIndustry}
              onChange={(e) =>
                setSelectedIndustry(
                  e.target.value === "all" ? "all" : Number(e.target.value),
                )
              }
              className="rounded border px-2.5 py-1 text-xs"
            >
              <option value="all">All Sections</option>
              {industries.map((ind) => (
                <option key={ind.id} value={ind.id}>
                  {ind.name}
                </option>
              ))}
            </select>

            <select
              value={selectedCandidateStatus}
              onChange={(e) => setSelectedCandidateStatus(e.target.value)}
              className="rounded border px-2.5 py-1 text-xs"
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="auto_enabled">Auto Enabled</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="border-b bg-muted/50 uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5">ID</th>
                  <th className="px-3 py-2.5">Name / Feed URL</th>
                  <th className="px-3 py-2.5">Section</th>
                  <th className="px-3 py-2.5">Kind</th>
                  <th className="px-3 py-2.5">Rung</th>
                  <th className="px-3 py-2.5">Browser Required</th>
                  <th className="px-3 py-2.5">Score</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Reason</th>
                  <th className="px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredCandidates.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2.5 font-mono text-[0.7rem] text-muted-foreground">
                      {c.id}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-foreground">
                        {c.name || c.siteDomain || "(unnamed)"}
                      </div>
                      <div className="font-mono text-[0.7rem] text-muted-foreground truncate max-w-xs">
                        {c.feedUrl}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {industries.find((i) => i.id === c.industryId)?.name ??
                        `#${c.industryId}`}
                    </td>
                    <td className="px-3 py-2.5 uppercase font-mono text-[0.7rem]">
                      {c.kind}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[0.7rem]">
                      {c.fetchRung ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      {c.requiresBrowser === 1 ? (
                        <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[0.7rem] font-semibold text-rose-600 dark:text-rose-400">
                          YES (Wall)
                        </span>
                      ) : (
                        <span className="text-muted-foreground">No</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[0.7rem]">
                      {c.avgScore !== null ? `${c.avgScore}/100` : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[0.7rem] font-semibold ${
                          c.status === "auto_enabled" || c.status === "approved"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : c.status === "rejected"
                              ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                              : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[0.7rem] text-muted-foreground">
                      {c.rejectionReason ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {c.status !== "approved" &&
                          c.status !== "auto_enabled" && (
                            <button
                              type="button"
                              disabled={actingId === c.id}
                              onClick={() => handleApproveCandidate(c.id)}
                              className="rounded bg-emerald-600 px-2 py-0.5 text-[0.7rem] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                            >
                              Approve
                            </button>
                          )}
                        {c.status === "pending" && (
                          <button
                            type="button"
                            disabled={actingId === c.id}
                            onClick={() => handleRejectCandidate(c.id)}
                            className="rounded border border-destructive/40 px-2 py-0.5 text-[0.7rem] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
