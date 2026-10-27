import { useRef, useState, type FormEvent } from "react";
import {
  FOLLOW_COPY,
  followSectionOptions,
  submitCreate,
  submitRevoke,
  type FieldErrors,
  type FollowFields,
} from "../lib/follow";
import type { ReaderWatchInput } from "../server/reader-watch/input";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

const CONTROL =
  "w-full border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-dashed";
const LABEL = "text-xs font-bold";
const HINT = "text-xs text-muted-foreground";
const BUTTON = "border text-xs font-bold";

function ErrorBox({ id, children }: { id?: string; children: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="border border-dashed px-2 py-1 text-sm font-bold"
    >
      {children}
    </p>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className={HINT}>
          {hint}
        </p>
      )}
      {error && <ErrorBox id={`${id}-error`}>{error}</ErrorBox>}
    </div>
  );
}

const describedBy = (id: string, hint: boolean, error?: string) =>
  [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ") || undefined;

export function FollowFormView({
  sections,
  fieldErrors,
  formError,
  pending,
  onSubmit,
}: {
  sections: { slug: string; name: string }[];
  fieldErrors: FieldErrors;
  formError: string | null;
  pending: boolean;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const options = followSectionOptions(sections);
  return (
    <form
      method="post"
      onSubmit={onSubmit}
      className="flex flex-col gap-3"
      aria-label="Create a watch"
    >
      <Field
        id="follow-question"
        label="Question"
        hint="10 to 200 characters."
        error={fieldErrors.question}
      >
        <textarea
          id="follow-question"
          name="question"
          rows={2}
          required
          maxLength={200}
          aria-invalid={fieldErrors.question ? true : undefined}
          aria-describedby={describedBy(
            "follow-question",
            true,
            fieldErrors.question,
          )}
          className={CONTROL}
        />
      </Field>
      <Field
        id="follow-criteria"
        label="What counts as real progress"
        hint="10 to 300 characters."
        error={fieldErrors.criteria}
      >
        <textarea
          id="follow-criteria"
          name="criteria"
          rows={3}
          required
          maxLength={300}
          aria-invalid={fieldErrors.criteria ? true : undefined}
          aria-describedby={describedBy(
            "follow-criteria",
            true,
            fieldErrors.criteria,
          )}
          className={CONTROL}
        />
      </Field>
      <Field
        id="follow-keywords"
        label="Keywords"
        hint="1 to 5, separated by commas. A story is checked only if it mentions one."
        error={fieldErrors.keywords}
      >
        <input
          id="follow-keywords"
          name="keywords"
          type="text"
          required
          maxLength={240}
          autoComplete="off"
          aria-invalid={fieldErrors.keywords ? true : undefined}
          aria-describedby={describedBy(
            "follow-keywords",
            true,
            fieldErrors.keywords,
          )}
          className={CONTROL}
        />
      </Field>
      <Field id="follow-section" label="Section">
        <select
          id="follow-section"
          name="industrySlug"
          defaultValue=""
          className={CONTROL}
        >
          <option value="">All sections</option>
          {options.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      {formError && <ErrorBox>{formError}</ErrorBox>}
      <div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending}
          className={BUTTON}
        >
          {pending ? "Creating…" : "Create watch"}
        </Button>
      </div>
      <p className={HINT}>{FOLLOW_COPY.stored}</p>
    </form>
  );
}

function CopyButton({
  text,
  target,
}: {
  text: string;
  target: React.RefObject<HTMLInputElement | null>;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={BUTTON}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            // No clipboard access: select the address so the reader can copy.
            target.current?.select();
            setCopied(false);
          }
        }}
      >
        Copy
      </Button>
      <span aria-live="polite" className={HINT}>
        {copied ? "Copied." : ""}
      </span>
    </>
  );
}

export function FollowSuccess({ feedUrl }: { feedUrl: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-2 border p-3"
    >
      <label htmlFor="follow-feed" className={LABEL}>
        Your private feed address
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="follow-feed"
          ref={input}
          type="text"
          readOnly
          value={feedUrl}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(CONTROL, "min-w-0 flex-1")}
        />
        <CopyButton text={feedUrl} target={input} />
      </div>
      <p className="text-sm font-bold">{FOLLOW_COPY.savedOnce}</p>
      <p className="text-sm text-muted-foreground">{FOLLOW_COPY.addToReader}</p>
    </div>
  );
}

export function RevokeFormView({
  error,
  done,
  pending,
  onSubmit,
}: {
  error: string | null;
  done: boolean;
  pending: boolean;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      method="post"
      onSubmit={onSubmit}
      className="flex flex-col gap-2"
      aria-label="Stop a feed"
    >
      <Field id="follow-revoke" label="Paste your feed address">
        <input
          id="follow-revoke"
          name="address"
          type="text"
          required
          autoComplete="off"
          spellCheck={false}
          className={cn(CONTROL, "")}
        />
      </Field>
      {error && <ErrorBox>{error}</ErrorBox>}
      {done && (
        <p role="status" className="text-sm font-bold">
          {FOLLOW_COPY.stopped}
        </p>
      )}
      <div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending}
          className={BUTTON}
        >
          Stop this feed
        </Button>
      </div>
    </form>
  );
}

const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
};

/** Create and stop forms. The feed address is held in state only. */
export function FollowPanel({
  sections,
  onCreate,
  onRevoke,
}: {
  sections: { slug: string; name: string }[];
  onCreate: (input: ReaderWatchInput) => Promise<unknown>;
  onRevoke: (token: string) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const fields: FollowFields = {
      question: text(fd, "question"),
      criteria: text(fd, "criteria"),
      keywords: text(fd, "keywords"),
      industrySlug: text(fd, "industrySlug"),
    };
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    const r = await submitCreate(fields, onCreate);
    setPending(false);
    if (r.kind === "ok") {
      setFeedUrl(r.feedUrl);
      form.reset();
    } else if (r.kind === "fields") {
      setFeedUrl(null);
      setFieldErrors(r.errors);
    } else {
      setFeedUrl(null);
      setFormError(r.message);
    }
  }

  async function revoke(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const address = text(new FormData(form), "address");
    setRevokePending(true);
    setRevokeError(null);
    setRevoked(false);
    const r = await submitRevoke(address, onRevoke);
    setRevokePending(false);
    if (r.kind === "ok") {
      setRevoked(true);
      form.reset();
    } else {
      setRevokeError(r.message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {feedUrl !== null && <FollowSuccess feedUrl={feedUrl} />}
      <FollowFormView
        sections={sections}
        fieldErrors={fieldErrors}
        formError={formError}
        pending={pending}
        onSubmit={create}
      />
      <section aria-labelledby="follow-stop" className="flex flex-col gap-2">
        <h2
          id="follow-stop"
          className="border-t-[3px] border-foreground pt-1 text-xs font-semibold"
        >
          Stop a feed
        </h2>
        <RevokeFormView
          error={revokeError}
          done={revoked}
          pending={revokePending}
          onSubmit={revoke}
        />
      </section>
    </div>
  );
}

/** The entry on /w. A plain link: it needs no router to render. */
export function FollowOwnLink() {
  return (
    <p className="text-sm">
      <a href="/follow" className="font-bold underline">
        Follow your own question →
      </a>
    </p>
  );
}
