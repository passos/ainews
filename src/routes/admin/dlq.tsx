import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { listDlqMessages, replayDlqMessage } from "../../server/admin/dlq";
import { ADMIN_TABLE } from "../../components/admin/table";

export const Route = createFileRoute("/admin/dlq")({
  ssr: "data-only",
  loader: () => listDlqMessages(),
  component: AdminDlqPage,
});

function AdminDlqPage() {
  const messages = Route.useLoaderData();
  const router = useRouter();

  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleReplay(id: string) {
    setReplayingId(id);
    setFeedback(null);
    setError(null);
    try {
      await replayDlqMessage({ data: id });
      setFeedback(`Message ${id} dispatched to appropriate queue for replay.`);
      await router.invalidate();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to replay: ${String(err)}`,
      );
    } finally {
      setReplayingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-12">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Dead Letter Queue</h1>
        <p className="text-sm text-muted-foreground">
          Review failed queue messages caught by the DLQ consumer. Messages can
          be replayed back into their target pipeline stage.
        </p>
      </div>

      {feedback && (
        <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
          {feedback}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {messages.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          Dead letter queue is empty. No failed messages.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className={`w-full text-left text-xs ${ADMIN_TABLE}`}>
            <thead className="border-b bg-muted/50 uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5">Message ID</th>
                <th className="px-3 py-2.5">Kind</th>
                <th className="px-3 py-2.5">Attempts</th>
                <th className="px-3 py-2.5">Received At</th>
                <th className="px-3 py-2.5">Replayed At</th>
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {messages.map((m) => {
                const isExpanded = expandedId === m.id;
                return (
                  <tr key={m.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2.5 font-mono text-[0.7rem]">
                      {m.id}
                    </td>
                    <td className="px-3 py-2.5 font-mono uppercase font-semibold">
                      {m.kind ?? "unknown"}
                    </td>
                    <td className="px-3 py-2.5 font-mono">{m.attempts}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {new Date(m.receivedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {m.replayedAt ? (
                        <span className="text-emerald-500">
                          {new Date(m.replayedAt).toLocaleString()}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedId(isExpanded ? null : m.id)
                          }
                          className="rounded border px-2 py-0.5 text-[0.7rem] hover:bg-muted"
                        >
                          {isExpanded ? "Hide Payload" : "View Payload"}
                        </button>
                        <button
                          type="button"
                          disabled={replayingId === m.id || !m.kind}
                          onClick={() => handleReplay(m.id)}
                          className="rounded bg-primary px-2 py-0.5 text-[0.7rem] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                          {m.replayedAt ? "Replay Again" : "Replay"}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="mt-2 text-left">
                          <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[0.65rem]">
                            {JSON.stringify(JSON.parse(m.bodyJson), null, 2)}
                          </pre>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
