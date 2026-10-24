import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { listIndustries } from "../../../server/admin/industries";
import {
  deleteSource,
  listSources,
  resumeSource,
  triggerCollect,
} from "../../../server/admin/sources";

export const Route = createFileRoute("/admin/sources/")({
  ssr: "data-only",
  loader: async () => {
    const [sources, industries] = await Promise.all([
      listSources(),
      listIndustries(),
    ]);
    return { sources, industries };
  },
  component: AdminSourcesPage,
});

function AdminSourcesPage() {
  const { sources, industries } = Route.useLoaderData();
  const router = useRouter();
  const [selectedIndustry, setSelectedIndustry] = useState<number | "all">(
    "all",
  );
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [actingId, setActingId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const filteredSources = sources.filter((s) => {
    if (selectedIndustry !== "all" && s.industryId !== selectedIndustry) {
      return false;
    }
    if (selectedStatus !== "all" && s.status !== selectedStatus) {
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Sources</h1>
          <p className="text-sm text-muted-foreground">
            Manage RSS feeds and HTML listing sources, inspect crawler health,
            and trigger ad-hoc fetches.
          </p>
        </div>
        <Link
          to="/admin/sources/$sourceId"
          params={{ sourceId: "new" }}
          className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
        >
          + Add Source
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-y py-3 text-sm">
        <div className="flex items-center gap-2">
          <label
            htmlFor="source-ind-filter"
            className="text-xs font-medium text-muted-foreground"
          >
            Section:
          </label>
          <select
            id="source-ind-filter"
            value={selectedIndustry}
            onChange={(e) =>
              setSelectedIndustry(
                e.target.value === "all" ? "all" : Number(e.target.value),
              )
            }
            className="rounded border bg-background px-2.5 py-1 text-xs"
          >
            <option value="all">All Sections</option>
            {industries.map((ind) => (
              <option key={ind.id} value={ind.id}>
                {ind.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor="source-status-filter"
            className="text-xs font-medium text-muted-foreground"
          >
            Status:
          </label>
          <select
            id="source-status-filter"
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="rounded border bg-background px-2.5 py-1 text-xs"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="candidate">Candidate</option>
            <option value="paused">Paused</option>
          </select>
        </div>
      </div>

      {message && (
        <div className="rounded-md border bg-muted p-3 text-xs">{message}</div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-xs">
          <thead className="border-b bg-muted/50 uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2.5">ID</th>
              <th className="px-3 py-2.5">Name</th>
              <th className="px-3 py-2.5">Section</th>
              <th className="px-3 py-2.5">Kind</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Fails / Empty</th>
              <th className="px-3 py-2.5">Last OK</th>
              <th className="px-3 py-2.5">Jina</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredSources.map((s) => (
              <tr key={s.id} className="hover:bg-muted/20">
                <td className="px-3 py-2.5 font-mono">#{s.id}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-col">
                    <span className="font-semibold">{s.name}</span>
                    <span className="font-mono text-[0.7rem] text-muted-foreground truncate max-w-xs">
                      {s.feedUrl}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5">{s.industryName}</td>
                <td className="px-3 py-2.5 uppercase font-mono">{s.kind}</td>
                <td className="px-3 py-2.5">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[0.7rem] font-bold uppercase ${
                      s.status === "active"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : s.status === "paused"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {s.status}
                  </span>
                </td>
                <td className="px-3 py-2.5 font-mono">
                  {s.failCount} / {s.emptyFetches}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  {s.lastOkAt ? new Date(s.lastOkAt).toLocaleDateString() : "—"}
                </td>
                <td className="px-3 py-2.5">
                  {s.jinaEnabled ? (
                    <span className="text-emerald-500 font-semibold">ON</span>
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
  );
}
