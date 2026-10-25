import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { safeHttpUrl } from "../../lib/url";
import {
  correctFundingRound,
  decideFundingRound,
  listPendingFundingRounds,
} from "../../server/admin/funding";

export const Route = createFileRoute("/admin/funding")({
  ssr: "data-only",
  loader: async () => ({ rounds: await listPendingFundingRounds() }),
  component: AdminFundingPage,
});

function amountText(amount: number | null, currency: string | null): string {
  return amount === null
    ? "undisclosed"
    : `${amount.toLocaleString("en-US")} ${currency ?? ""}`;
}

function AdminFundingPage() {
  const { rounds: initial } = Route.useLoaderData();
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
