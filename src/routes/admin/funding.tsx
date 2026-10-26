import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { safeHttpUrl } from "../../lib/url";
import {
  correctFundingRound,
  decideFundingRound,
  listFundingObservations,
  listPendingFundingRounds,
  resolveFundingObservation,
} from "../../server/admin/funding";
import type { FundingObservationView } from "../../server/admin/ops";

export const Route = createFileRoute("/admin/funding")({
  ssr: "data-only",
  loader: async () => ({
    rounds: await listPendingFundingRounds(),
    observations: await listFundingObservations(),
  }),
  component: AdminFundingPage,
});

function amountText(amount: number | null, currency: string | null): string {
  return amount === null
    ? "undisclosed"
    : `${amount.toLocaleString("en-US")} ${currency ?? ""}`;
}

function AdminFundingPage() {
  const { rounds: initial, observations } = Route.useLoaderData();
  const [rounds, setRounds] = useState(initial);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);

  async function decide(roundId: number, decision: "published" | "rejected") {
    setBusyId(roundId);
    setError(null);
    setNotice(null);
    try {
      const result = await decideFundingRound({ data: { roundId, decision } });
      if (!result.updated)
        throw new Error("This round has changed. Refresh and try again.");
      setRounds(await listPendingFundingRounds());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusyId(null);
    }
  }

  async function correct(data: {
    roundId: number;
    amount: number | null;
    currency: string;
    reason: string;
  }) {
    setBusyId(data.roundId);
    setError(null);
    setNotice(null);
    try {
      const result = await correctFundingRound({ data });
      if (!result.updated)
        throw new Error("This round has changed. Refresh and try again.");
      setRounds(await listPendingFundingRounds());
      setNotice("Correction saved as a new version awaiting review.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Correction failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Funding rounds awaiting review</h1>
        <p className="text-sm text-muted-foreground">
          Extracted from approved Finance articles. Nothing here is public until
          you publish it. Replaced versions leave the public tracker while the
          correction is reviewed. Rejecting a correction restores the last
          published version, or the previous pending version if none was
          published. Approved corrections retain their public history.
        </p>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <ObservationQueue
        initial={observations}
        onApplied={async () => setRounds(await listPendingFundingRounds())}
      />
      <h2 className="text-xl font-semibold">Rounds</h2>
      {rounds.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to review.</p>
      ) : (
        <ul className="space-y-3">
          {rounds.map((r) => (
            <li key={r.id} className="space-y-1 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  {r.companyName} · {r.roundName}
                </h2>
                <span className="font-mono text-sm">
                  {amountText(r.amount, r.currency)}
                </span>
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                {r.stage} · {r.sector}
                {r.announcedDate && ` · ${r.announcedDate}`} · {r.sourceCount}{" "}
                source article(s)
              </p>
              {r.investors.length > 0 && (
                <p className="text-sm">Investors: {r.investors.join(", ")}</p>
              )}
              {r.previousId !== null && (
                <p className="text-sm">
                  Replaces published #{r.previousId} (
                  {amountText(r.previousAmount, r.previousCurrency)}).
                  {r.correctionReason && ` ${r.correctionReason}`}
                </p>
              )}
              {safeHttpUrl(r.sourceUrl) && (
                <p className="text-xs">
                  <a
                    href={safeHttpUrl(r.sourceUrl) ?? undefined}
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    First source
                  </a>
                </p>
              )}
              <FundingCorrectionForm
                roundId={r.id}
                amount={r.amount}
                currency={r.currency}
                busy={busyId !== null}
                onSave={correct}
              />
              <div className="flex gap-2 pt-2">
                <Button
                  disabled={busyId !== null}
                  onClick={() => decide(r.id, "published")}
                >
                  Publish
                </Button>
                <Button
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => decide(r.id, "rejected")}
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FundingCorrectionForm({
  roundId,
  amount,
  currency,
  busy,
  onSave,
}: {
  roundId: number;
  amount: number | null;
  currency: string;
  busy: boolean;
  onSave: (data: {
    roundId: number;
    amount: number | null;
    currency: string;
    reason: string;
  }) => Promise<void>;
}) {
  const [value, setValue] = useState(amount === null ? "" : String(amount));
  const [unit, setUnit] = useState(currency);
  const [reason, setReason] = useState("");
  return (
    <details className="pt-2">
      <summary className="cursor-pointer text-sm underline">
        Edit amount or currency
      </summary>
      <form
        className="mt-3 grid max-w-lg gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            roundId,
            amount: value.trim() === "" ? null : Number(value),
            currency: unit,
            reason,
          });
        }}
      >
        <label
          className="grid gap-1 text-sm"
          htmlFor={`funding-amount-${roundId}`}
        >
          Amount (leave empty if undisclosed)
          <input
            className="rounded border bg-background px-3 py-2"
            id={`funding-amount-${roundId}`}
            type="number"
            min="0"
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
        </label>
        <label
          className="grid gap-1 text-sm"
          htmlFor={`funding-currency-${roundId}`}
        >
          Currency (three-letter code)
          <input
            className="rounded border bg-background px-3 py-2"
            id={`funding-currency-${roundId}`}
            required
            pattern="[A-Za-z]{3}"
            maxLength={3}
            value={unit}
            onChange={(e) => setUnit(e.target.value.toUpperCase())}
            disabled={busy}
          />
        </label>
        <label
          className="grid gap-1 text-sm"
          htmlFor={`funding-reason-${roundId}`}
        >
          Reason for correction
          <textarea
            className="rounded border bg-background px-3 py-2"
            id={`funding-reason-${roundId}`}
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
          />
        </label>
        <Button type="submit" variant="outline" disabled={busy}>
          Save correction for review
        </Button>
      </form>
    </details>
  );
}

type ObservationAction =
  | { action: "attach_existing"; roundId: number }
  | {
      action: "confirm_new";
      companyName: string;
      roundName: string;
      announcedDate: string | null;
    }
  | { action: "reject" };

/** Observations whose identity the administrator must confirm. */
function ObservationQueue({
  initial,
  onApplied,
}: {
  initial: FundingObservationView[];
  onApplied: () => Promise<void>;
}) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(
    item: FundingObservationView,
    reason: string,
    action: ObservationAction,
  ) {
    setBusy(true);
    setError(null);
    try {
      const result = await resolveFundingObservation({
        data: {
          ...action,
          observationId: item.id,
          expectedRevision: item.decisionRevision,
          reason,
        },
      });
      if (!result.updated)
        throw new Error("This observation has changed. Refresh and try again.");
      if (result.result === "ignored")
        setError(
          "Decision saved, but the round was held for review. See the queue.",
        );
      setItems(await listFundingObservations());
      await onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Observations awaiting identity</h2>
      <p className="text-sm text-muted-foreground">
        The model found these rounds, but the company, round or announcement
        date is missing or conflicts. Confirming an identity does not publish
        anything.
      </p>
      {error && (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to resolve.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <ObservationItem
              key={item.id}
              item={item}
              busy={busy}
              onAct={act}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ObservationItem({
  item,
  busy,
  onAct,
}: {
  item: FundingObservationView;
  busy: boolean;
  onAct: (
    item: FundingObservationView,
    reason: string,
    action: ObservationAction,
  ) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [roundId, setRoundId] = useState(item.candidates[0]?.id ?? 0);
  const [companyName, setCompanyName] = useState(item.companyName);
  const [roundName, setRoundName] = useState(item.roundName);
  const [date, setDate] = useState(
    /^\d{4}-\d{2}-\d{2}$/.test(item.announcedDate ?? "")
      ? item.announcedDate!
      : "",
  );
  const [dateUnknown, setDateUnknown] = useState(false);
  const articleUrl = safeHttpUrl(item.articleUrl);
  const reasonOk = reason.trim().length >= 3;
  const id = item.id.replace(/[^A-Za-z0-9_-]/g, "-");
  return (
    <li className="space-y-2 rounded-lg border bg-card p-4">
      <h3 className="text-lg font-semibold">
        {item.companyName} · {item.roundName}
        {item.announcedDate ? ` · ${item.announcedDate}` : " · date not given"}
      </h3>
      <p className="text-xs">
        {articleUrl ? (
          <a href={articleUrl} rel="noopener noreferrer" className="underline">
            {item.articleTitle}
          </a>
        ) : (
          item.articleTitle
        )}
        {item.companyHost && ` · host ${item.companyHost}`}
      </p>
      <details>
        <summary className="cursor-pointer text-sm underline">
          Evidence ({item.evidence.length})
        </summary>
        <ul className="mt-2 space-y-1 text-sm">
          {item.evidence.map((e, i) => (
            <li key={i}>
              <span className="font-mono text-xs">{e.field}</span>:{" "}
              <q>{e.quote}</q>
            </li>
          ))}
        </ul>
      </details>
      <label className="grid gap-1 text-sm" htmlFor={`obs-reason-${id}`}>
        Reason for the decision
        <textarea
          className="rounded border bg-background px-3 py-2"
          id={`obs-reason-${id}`}
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
      </label>
      {item.candidates.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm" htmlFor={`obs-round-${id}`}>
            Same company: attach to round
            <select
              className="rounded border bg-background px-3 py-2"
              id={`obs-round-${id}`}
              value={roundId}
              onChange={(e) => setRoundId(Number(e.target.value))}
              disabled={busy}
            >
              {item.candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.id} {c.companyName} · {c.roundName} ·{" "}
                  {c.announcedDate ?? "date unknown"} ·{" "}
                  {amountText(c.amount, c.currency)} · {c.status}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            disabled={busy || !reasonOk || !roundId}
            onClick={() =>
              onAct(item, reason, { action: "attach_existing", roundId })
            }
          >
            Attach
          </Button>
        </div>
      )}
      <form
        className="grid max-w-lg gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void onAct(item, reason, {
            action: "confirm_new",
            companyName,
            roundName,
            announcedDate: dateUnknown ? null : date,
          });
        }}
      >
        <label className="grid gap-1 text-sm" htmlFor={`obs-company-${id}`}>
          Company
          <input
            className="rounded border bg-background px-3 py-2"
            id={`obs-company-${id}`}
            required
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`obs-roundname-${id}`}>
          Round
          <input
            className="rounded border bg-background px-3 py-2"
            id={`obs-roundname-${id}`}
            required
            value={roundName}
            onChange={(e) => setRoundName(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`obs-date-${id}`}>
          Announcement date
          <input
            className="rounded border bg-background px-3 py-2"
            id={`obs-date-${id}`}
            type="date"
            required={!dateUnknown}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={busy || dateUnknown}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dateUnknown}
            onChange={(e) => setDateUnknown(e.target.checked)}
            disabled={busy}
          />
          The source does not give the announcement date
        </label>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !reasonOk}>
            Confirm as a new round
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !reasonOk}
            onClick={() => onAct(item, reason, { action: "reject" })}
          >
            Reject observation
          </Button>
        </div>
      </form>
    </li>
  );
}
