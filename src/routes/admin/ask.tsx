import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { formatUtc } from "../../lib/time";
import { listQuestions, submitQuestion } from "../../server/admin/ask";
import type {
  QuestionCitationItem,
  QuestionItem,
  QuestionSupplementalFetchItem,
} from "../../server/admin/ops";

export const Route = createFileRoute("/admin/ask")({
  ssr: "data-only",
  loader: async () => listQuestions(),
  component: AdminAskPage,
});

function AdminAskPage() {
  const questions = Route.useLoaderData();
  const router = useRouter();

  const [questionText, setQuestionText] = useState("");
  const [scopeType, setScopeType] = useState<"global" | "event">("global");
  const [eventIdStr, setEventIdStr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(
    questions.length > 0 ? questions[0].id : null,
  );

  const selectedQuestion: QuestionItem | undefined =
    questions.find((q) => q.id === selectedId) ?? questions[0];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!questionText.trim()) return;

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const eventIdNum =
        scopeType === "event" && eventIdStr.trim()
          ? parseInt(eventIdStr.trim(), 10)
          : undefined;

      const res = await submitQuestion({
        data: {
          question: questionText.trim(),
          scopeType,
          eventId: eventIdNum,
        },
      });

      setQuestionText("");
      if (res?.questionId) {
        setSelectedId(res.questionId);
      }
      await router.invalidate();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to submit question",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-serif text-2xl font-bold tracking-tight">
            Ask Newsren (Admin Research Desk)
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask evidence-backed research questions across verified articles or
            scoped events. Answers require verbatim citations; unsupported
            claims are refused.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.invalidate()}
          className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Refresh Status
        </button>
      </div>

      {errorMessage && (
        <div className="rounded-md bg-destructive/15 p-3 font-mono text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {/* New Question Form */}
      <section className="rounded-lg border bg-card p-5 shadow-sm">
        <h3 className="text-base font-semibold">New Research Inquiry</h3>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
          <div>
            <label
              htmlFor="question-input"
              className="block text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Question
            </label>
            <textarea
              id="question-input"
              rows={3}
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              placeholder="e.g. What are the key independent benchmarks for DeepSeek-R1 reported across verified papers?"
              className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              required
            />
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-4">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Scope:
              </span>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="scope"
                  value="global"
                  checked={scopeType === "global"}
                  onChange={() => setScopeType("global")}
                  className="text-primary focus:ring-primary"
                />
                Global (All Approved Articles)
              </label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="scope"
                  value="event"
                  checked={scopeType === "event"}
                  onChange={() => setScopeType("event")}
                  className="text-primary focus:ring-primary"
                />
                Specific Event
              </label>
            </div>

            {scopeType === "event" && (
              <div className="flex items-center gap-2">
                <label
                  htmlFor="event-id-input"
                  className="text-xs text-muted-foreground"
                >
                  Event ID:
                </label>
                <input
                  id="event-id-input"
                  type="number"
                  min="1"
                  value={eventIdStr}
                  onChange={(e) => setEventIdStr(e.target.value)}
                  placeholder="e.g. 42"
                  className="w-24 rounded-md border bg-background px-2.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  required
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !questionText.trim()}
              className="ml-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Ask Agent"}
            </button>
          </div>
        </form>
      </section>

      {/* Main Content Grid: History & Details */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column: Inquiry History */}
        <div className="md:col-span-1 flex flex-col gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Inquiry History ({questions.length})
          </h3>
          <div className="flex flex-col gap-2 max-h-[700px] overflow-y-auto pr-1">
            {questions.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No questions asked yet.
              </div>
            ) : (
              questions.map((q) => {
                const isSelected = selectedQuestion?.id === q.id;
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setSelectedId(q.id)}
                    className={`flex flex-col text-left gap-1.5 rounded-lg border p-3 text-xs transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        #{q.id} · {formatUtc(q.createdAt)}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          q.status === "completed"
                            ? q.refusal
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                            : q.status === "processing"
                              ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 animate-pulse"
                              : q.status === "failed"
                                ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                                : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {q.status === "completed"
                          ? q.refusal
                            ? "Refusal"
                            : "Answered"
                          : q.status}
                      </span>
                    </div>
                    <div className="font-medium line-clamp-2 text-foreground">
                      {q.question}
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1">
                      <span>
                        {q.scopeType === "event"
                          ? `Event #${q.eventId}`
                          : "Global"}
                        {q.origin === "public" && " · Reader"}
                      </span>
                      <span>${(q.costMicros / 1_000_000).toFixed(4)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Selected Inquiry Detail */}
        <div className="md:col-span-2">
          {selectedQuestion ? (
            <div className="rounded-lg border bg-card p-6 shadow-sm flex flex-col gap-6">
              {/* Header */}
              <div className="flex flex-col gap-2 border-b pb-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    Inquiry #{selectedQuestion.id} ·{" "}
                    {formatUtc(selectedQuestion.createdAt)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded">
                      Cost: $
                      {(selectedQuestion.costMicros / 1_000_000).toFixed(4)}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        selectedQuestion.status === "completed"
                          ? selectedQuestion.refusal
                            ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                            : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : selectedQuestion.status === "failed"
                            ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                            : "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 animate-pulse"
                      }`}
                    >
                      {selectedQuestion.status === "completed"
                        ? selectedQuestion.refusal
                          ? "Refusal (Insufficient Evidence)"
                          : "Answer Verified"
                        : selectedQuestion.status}
                    </span>
                  </div>
                </div>
                <h3 className="font-serif text-xl font-bold text-foreground">
                  {selectedQuestion.question}
                </h3>
                <div className="text-xs text-muted-foreground">
                  Scope:{" "}
                  <span className="font-semibold">
                    {selectedQuestion.scopeType}
                  </span>
                  {selectedQuestion.eventId &&
                    ` (Event #${selectedQuestion.eventId})`}
                  {` · Origin: ${selectedQuestion.origin}`}
                  {selectedQuestion.model &&
                    ` · Model: ${selectedQuestion.model}`}
                </div>
              </div>

              {/* Status Pending or Processing */}
              {selectedQuestion.status === "pending" && (
                <div className="rounded-md bg-muted/60 p-6 text-center text-sm text-muted-foreground">
                  This question is queued in Q_GENERATE for research.
                </div>
              )}
              {selectedQuestion.status === "processing" && (
                <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 p-6 text-center text-sm text-blue-700 dark:text-blue-300 animate-pulse">
                  Agent is retrieving verified chunks, checking evidence
                  sufficiency, and generating cited response...
                </div>
              )}

              {/* Status Failed */}
              {selectedQuestion.status === "failed" && (
                <div className="rounded-md bg-destructive/15 p-4 text-sm text-destructive">
                  <div className="font-semibold">Processing Failed</div>
                  <div className="mt-1 font-mono text-xs">
                    {selectedQuestion.errorMessage || "Unknown error occurred"}
                  </div>
                </div>
              )}

              {/* Status Completed */}
              {selectedQuestion.status === "completed" && (
                <div className="flex flex-col gap-6">
                  {/* Refusal Notice */}
                  {selectedQuestion.refusal && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 p-4 text-sm text-amber-800 dark:text-amber-200">
                      <div className="font-semibold flex items-center gap-1.5">
                        <span>⚠️</span> Evidence Insufficient / Refusal
                        Guardrail Triggered
                      </div>
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        The agent could not find sufficient verified facts in
                        the database to answer this inquiry. The agent refuses
                        to hallucinate unverified details.
                      </p>
                    </div>
                  )}

                  {/* Answer text */}
                  <div className="flex flex-col gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Grounded Answer
                    </h4>
                    <div className="prose prose-sm dark:prose-invert max-w-none rounded-md bg-muted/30 p-4 border text-foreground whitespace-pre-wrap">
                      {selectedQuestion.answer || "No answer text generated."}
                    </div>
                  </div>

                  {/* Unverified Notes */}
                  {selectedQuestion.unverified &&
                    selectedQuestion.unverified.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                          Unverified Aspects & Gaps (
                          {selectedQuestion.unverified.length})
                        </h4>
                        <ul className="list-disc list-inside rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/10 p-3 text-xs text-muted-foreground space-y-1">
                          {selectedQuestion.unverified.map((u, idx) => (
                            <li key={idx} className="text-foreground">
                              {u}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                  {/* Verified Citations */}
                  <div className="flex flex-col gap-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Verified Verbatim Citations (
                      {selectedQuestion.citations?.length ?? 0})
                    </h4>
                    {!selectedQuestion.citations ||
                    selectedQuestion.citations.length === 0 ? (
                      <div className="rounded-md border border-dashed p-4 text-xs text-center text-muted-foreground">
                        No verified citations available.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3">
                        {(
                          selectedQuestion.citations as QuestionCitationItem[]
                        ).map((cit, idx) => (
                          <div
                            key={idx}
                            className="rounded-md border bg-background p-3.5 flex flex-col gap-2 shadow-xs"
                          >
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-semibold text-foreground">
                                Claim: {cit.claim}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {cit.isPrimarySource && (
                                  <span className="rounded bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300 px-1.5 py-0.5 text-[10px] font-medium">
                                    Primary Source
                                  </span>
                                )}
                                <span className="rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 px-1.5 py-0.5 text-[10px] font-medium">
                                  Verified
                                </span>
                              </div>
                            </div>
                            <blockquote className="border-l-2 border-emerald-500 pl-3 py-0.5 text-xs italic bg-emerald-50/30 dark:bg-emerald-950/10 rounded-r text-foreground/90">
                              "{cit.quote}"
                            </blockquote>
                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                              <span>Article #{cit.articleId}</span>
                              <span className="font-mono">
                                Offsets: {cit.startOffset}–{cit.endOffset}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Supplemental Fetch Logs */}
                  {selectedQuestion.supplementalFetched &&
                    selectedQuestion.supplementalFetched.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Supplemental Whitelist Fetches
                        </h4>
                        <div className="rounded-md border bg-muted/20 p-3 flex flex-col gap-2 text-xs">
                          {(
                            selectedQuestion.supplementalFetched as QuestionSupplementalFetchItem[]
                          ).map((s, idx) => (
                            <div
                              key={idx}
                              className="flex items-center justify-between gap-2 font-mono text-[11px]"
                            >
                              <span className="truncate">{s.url}</span>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${
                                  s.status === "ok"
                                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                                    : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                                }`}
                              >
                                {s.status}{" "}
                                {s.rung !== null ? `(Rung ${s.rung})` : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
              Select an inquiry from the history to view its grounded analysis
              and citations.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
