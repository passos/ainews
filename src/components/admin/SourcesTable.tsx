import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import {
  ADMIN_TABLE,
  ADMIN_TABLE_WRAP,
  ADMIN_URL_CELL,
  ADMIN_WRAP_CELL,
} from "./table";

export interface SourceRowView {
  id: number;
  industryId: number;
  name: string;
  feedUrl: string;
  kind: string;
  status: string;
  pausedReason: string | null;
  fetchRung: number | null;
  failCount: number;
  lastOkAt: number | null;
  jinaEnabled: number;
  articleCount: number;
}

export interface DeleteTarget {
  id: number;
  name: string;
  articleCount: number;
}

/** Delete is always available: the source's articles stay on the site. */
export function SourceDeleteButton({
  working,
  onClick,
}: {
  working: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={working}
      onClick={onClick}
      className="rounded border border-destructive/40 px-2 py-0.5 text-[0.7rem] text-destructive hover:bg-destructive/10"
    >
      Delete
    </button>
  );
}

export function SourcesTable({
  sources,
  industries,
  actingId,
  onResume,
  onTrigger,
  onDelete,
}: {
  sources: SourceRowView[];
  industries: { id: number; name: string }[];
  actingId: number | null;
  onResume: (id: number) => void;
  onTrigger: (id: number) => void;
  onDelete: (source: DeleteTarget) => void;
}) {
  return (
    <div className={ADMIN_TABLE_WRAP}>
      <table className={`w-full text-left text-xs ${ADMIN_TABLE}`}>
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
          {sources.map((s) => (
            <tr key={s.id} className="hover:bg-muted/30">
              <td className="px-3 py-2.5 font-mono text-[0.7rem] text-muted-foreground">
                {s.id}
              </td>
              <td className="px-3 py-2.5">
                <div
                  className={`${ADMIN_WRAP_CELL} min-w-40 font-semibold text-foreground`}
                >
                  {s.name || "(unnamed)"}
                </div>
                <div
                  className={`${ADMIN_URL_CELL} min-w-40 max-w-xs font-mono text-[0.7rem] text-muted-foreground`}
                >
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
                      onClick={() => onResume(s.id)}
                      className="rounded bg-emerald-600 px-2 py-0.5 text-[0.7rem] font-semibold text-white hover:bg-emerald-700"
                    >
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={actingId === s.id}
                    onClick={() => onTrigger(s.id)}
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
                  <SourceDeleteButton
                    working={actingId === s.id}
                    onClick={() =>
                      onDelete({
                        id: s.id,
                        name: s.name,
                        articleCount: s.articleCount,
                      })
                    }
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Native <dialog> opened with showModal() while `target` is set. A server
 * error shows inside the dialog. Escape and the backdrop call onCancel.
 */
export function DeleteSourceDialog({
  target,
  error,
  working,
  onCancel,
  onConfirm,
}: {
  target: DeleteTarget | null;
  error: string | null;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = target !== null;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onCancel}
      className="m-auto w-full max-w-md rounded-lg border bg-background p-5 text-foreground backdrop:bg-black/40"
    >
      {target && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="break-words text-base font-semibold">
              Delete source #{target.id} {target.name}?
            </h2>
            <p className="text-sm text-muted-foreground">
              Its {target.articleCount} articles stay on the site; the source
              stops being collected.
            </p>
          </div>
          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={working}
              onClick={onCancel}
              className="rounded border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={working}
              onClick={onConfirm}
              className="rounded bg-destructive px-3 py-1 text-xs font-semibold text-white hover:bg-destructive/90 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
