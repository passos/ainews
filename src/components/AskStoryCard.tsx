import { useEffect, useRef, useState, type FormEvent } from "react";
import { ASK_COPY, pollAnswer, submitAsk, type AskState } from "../lib/ask";
import type { StoryAnswer } from "../server/reader-ask/ask";
import type { AnswerInput, AskInput } from "../server/reader-ask/input";
import { Button } from "./ui/button";

const LABEL =
  "font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground";
const CONTROL =
  "w-full rounded-sm border-2 bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const BUTTON =
  "rounded-sm border-2 font-mono text-xs font-bold uppercase tracking-wider";

export interface AskStoryFns {
  onAsk: (input: AskInput) => Promise<unknown>;
  onPoll: (input: AnswerInput) => Promise<unknown>;
}

// Model text (answer, claim) and source text are untrusted: plain text only.
function AnswerBlock({ answer }: { answer: StoryAnswer }) {
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {answer.refusal || answer.answer === null ? (
        <p className="text-sm font-bold">{ASK_COPY.refusal}</p>
      ) : (
        <div className="flex flex-col gap-1 border-l-2 border-border pl-3">
          <h3 className={LABEL}>{ASK_COPY.answerLabel}</h3>
          <p className="text-xs text-muted-foreground">{ASK_COPY.answerNote}</p>
          <p className="whitespace-pre-line text-sm leading-relaxed">
            {answer.answer}
          </p>
        </div>
      )}
      {answer.citations.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className={LABEL}>{ASK_COPY.verified}</h3>
          <ul className="flex flex-col gap-2">
            {answer.citations.map((c, i) => (
              <li key={i} className="border-l-2 border-border pl-3 text-sm">
                <blockquote className="font-serif leading-snug">
                  “{c.quote}”
                </blockquote>
                <p className="text-xs text-muted-foreground">{c.claim}</p>
                <p className="font-mono text-[0.7rem]">
                  <a href={c.href} className="underline">
                    {c.title}
                  </a>{" "}
                  · {c.sourceName}
                  {c.url && (
                    <>
                      {" · "}
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="underline"
                      >
                        Original
                      </a>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {answer.unverified.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className={LABEL}>{ASK_COPY.unverified}</h3>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {answer.unverified.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AskStoryView({
  state,
  pending,
  onSubmit,
}: {
  state: AskState;
  pending: boolean;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const busy = pending || state.kind === "waiting";
  return (
    <section
      aria-label={ASK_COPY.title}
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 border-b border-border pb-2">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest">
          {ASK_COPY.title}
        </h2>
      </header>
      {/* method="post": a submit before hydration does not put the question in the URL. */}
      <form method="post" onSubmit={onSubmit} className="flex flex-col gap-2">
        <label htmlFor="ask-question" className="text-xs text-muted-foreground">
          {ASK_COPY.intro}
        </label>
        <textarea
          id="ask-question"
          name="question"
          rows={2}
          required
          minLength={10}
          maxLength={300}
          className={CONTROL}
        />
        <div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy}
            className={BUTTON}
          >
            Ask
          </Button>
        </div>
      </form>
      <div className="mt-3">
        {state.kind === "waiting" && (
          <p className="font-mono text-xs text-muted-foreground" role="status">
            {ASK_COPY.researching}
          </p>
        )}
        {state.kind === "done" && <AnswerBlock answer={state.answer} />}
        {state.kind === "timeout" && (
          <p className="text-sm">{ASK_COPY.timeout}</p>
        )}
        {state.kind === "error" && (
          <p
            role="alert"
            className="border-2 border-dashed px-2 py-1 text-sm font-bold"
          >
            {state.message}
          </p>
        )}
      </div>
    </section>
  );
}

export function AskStoryCard({
  eventId,
  onAsk,
  onPoll,
}: AskStoryFns & { eventId: number }) {
  const [state, setState] = useState<AskState>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get("question") ?? "");
    setPending(true);
    const sent = await submitAsk(eventId, text, onAsk);
    if (!alive.current) return;
    setPending(false);
    if (sent.kind === "error") {
      setState({ kind: "error", message: sent.message });
      return;
    }
    setState({ kind: "waiting" });
    // Stops polling once the card is gone.
    const result = await pollAnswer(() =>
      alive.current
        ? onPoll({ questionId: sent.questionId, token: sent.token })
        : Promise.reject(new Error("unmounted")),
    );
    if (!alive.current) return;
    setState(
      result.kind === "done"
        ? { kind: "done", answer: result.answer }
        : result.kind === "timeout"
          ? { kind: "timeout" }
          : { kind: "error", message: result.message },
    );
  }

  return (
    <AskStoryView state={state} pending={pending} onSubmit={handleSubmit} />
  );
}
