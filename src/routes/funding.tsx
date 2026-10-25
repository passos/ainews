import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Disclaimer } from "../components/Disclaimer";
import { buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";
import {
  getFundingPage,
  getFundingRoundDetails,
} from "../server/publication/api";

const searchSchema = z.object({
  sector: z.string().min(1).max(64).optional().catch(undefined),
  stage: z.string().min(1).max(64).optional().catch(undefined),
  investor: z.string().min(1).max(200).optional().catch(undefined),
  page: z.number().int().min(1).max(10_000).optional().catch(undefined),
});

export const Route = createFileRoute("/funding")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    sector: search.sector,
    stage: search.stage,
    investor: search.investor,
    page: search.page ?? 1,
  }),
  loader: ({ deps }) => getFundingPage({ data: deps }),
  head: () => ({
    meta: [{ title: "Funding Round Tracker — Personal News" }],
  }),
  component: FundingPage,
});

function label(slug: string): string {
  return slug.replace(/_/g, " ");
}

function money(amount: number | null, currency: string): string {
  if (amount === null) return "Undisclosed";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function usdTotal(micros: string): string {
  const value = BigInt(micros),
    remainder = value % 1_000_000n;
  const fraction = remainder.toString().padStart(6, "0").replace(/0+$/, "");
  return `$${(value / 1_000_000n).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

function FundingPage() {
  const { disclaimer, list, trends } = Route.useLoaderData();
  const search = Route.useSearch();
  const page = list.page;
  const hasMore = page * list.pageSize < list.total;
  const filtered = search.sector || search.stage || search.investor;

  return (
    <div data-section="finance" className="flex flex-col gap-4 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t-[5px] border-sec pt-1">
        <h1 className="font-serif text-3xl font-black uppercase tracking-tight text-sec-ink sm:text-4xl">
          Funding Round Tracker
        </h1>
        <Link
          to="/s/$section"
          params={{ section: "finance" }}
          className="font-mono text-xs font-bold uppercase tracking-wider underline hover:text-sec-ink"
        >
          Finance news
        </Link>
      </div>
      <Disclaimer text={disclaimer} />
      <p className="max-w-prose text-sm text-muted-foreground">
        Venture rounds reported in articles we have reviewed and approved, by
        sector, stage and investor. Counts and totals describe what was
        reported. They are not a ranking or rating of any company.
      </p>

      <section aria-label="Trends" className="grid gap-4 md:grid-cols-3">
        <div className="border-2 p-3">
          <h2 className="mb-2 font-mono text-xs font-bold uppercase tracking-widest">
            By sector
          </h2>
          {trends.bySector.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rounds yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {trends.bySector.map((s) => (
                <li key={s.sector} className="flex justify-between gap-2">
                  <Link
                    to="/funding"
                    search={{ sector: s.sector }}
                    className="underline"
                  >
                    {label(s.sector)}
                  </Link>
                  <span className="font-mono text-xs">
                    {s.rounds} {s.rounds === 1 ? "round" : "rounds"}
                    {s.disclosedRounds > 0 &&
                      ` · ${usdTotal(s.totalMicros)} (${s.disclosedRounds} disclosed, ${s.convertedRounds} converted)`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-2 p-3">
          <h2 className="mb-2 font-mono text-xs font-bold uppercase tracking-widest">
            By stage
          </h2>
          {trends.byStage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rounds yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {trends.byStage.map((s) => (
                <li key={s.stage} className="flex justify-between gap-2">
                  <Link
                    to="/funding"
                    search={{ stage: s.stage }}
                    className="underline"
                  >
                    {label(s.stage)}
                  </Link>
                  <span className="font-mono text-xs">{s.rounds}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-2 p-3">
          <h2 className="mb-2 font-mono text-xs font-bold uppercase tracking-widest">
            Investor activity
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Number of reported rounds each investor took part in.
          </p>
          {trends.investorActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rounds yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {trends.investorActivity.map((i) => (
                <li key={i.name} className="flex justify-between gap-2">
                  <Link
                    to="/funding"
                    search={{ investor: i.name }}
                    className="underline"
                  >
                    {i.name}
                  </Link>
                  <span className="font-mono text-xs">{i.rounds}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="Rounds" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="font-mono text-xs font-bold uppercase tracking-widest">
            Reported rounds ({list.total})
          </h2>
          {filtered && (
            <>
              <span className="font-mono text-xs text-muted-foreground">
                {[search.sector, search.stage, search.investor]
                  .filter(Boolean)
                  .map((v) => label(String(v)))
                  .join(" · ")}
              </span>
              <Link
                to="/funding"
                className="font-mono text-xs font-bold uppercase underline"
              >
                Clear filter
              </Link>
            </>
          )}
        </div>
        {list.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No funding rounds match.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {list.items.map((r) => (
              <li key={r.id} className="border-2 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-serif text-xl font-bold">
                    {r.companyName}
                  </h3>
                  <span className="font-mono text-sm font-bold">
                    {money(r.amount, r.currency)}
                  </span>
                </div>
                <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                  {r.roundName} · {label(r.sector)}
                  {r.announcedDate && ` · ${r.announcedDate}`}
                </p>
                {r.amount !== null && r.amountMicros === null && (
                  <p className="text-xs text-muted-foreground">
                    Native amount disclosed; currency excluded from USD totals.
                  </p>
                )}
                {r.investors.length > 0 && (
                  <p className="mt-2 text-sm">
                    <span className="font-semibold">Investors: </span>
                    {r.investors
                      .map((n) =>
                        r.leadInvestors.includes(n) ? `${n} (lead)` : n,
                      )
                      .join(", ")}
                  </p>
                )}
                {r.valuation !== null && (
                  <p className="text-sm">
                    <span className="font-semibold">Reported valuation: </span>
                    {money(r.valuation, r.currency)}
                  </p>
                )}
                {r.corrections.map((c) => (
                  <p
                    key={c.createdAt}
                    className="mt-2 border-l-4 border-sec pl-2 text-sm"
                  >
                    <span className="font-semibold">Correction: </span>
                    {c.body}
                  </p>
                ))}
                {r.sources.length > 0 && (
                  <p className="mt-2 font-mono text-xs">
                    <span className="mr-2 font-bold uppercase tracking-widest text-muted-foreground">
                      Sources
                    </span>
                    {r.sources.map((s, i) => (
                      <span key={s.articleId}>
                        {i > 0 && " · "}
                        <a
                          href={s.url}
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          {s.title}
                        </a>
                      </span>
                    ))}
                  </p>
                )}
                <FundingHistory roundId={r.id} />
              </li>
            ))}
          </ul>
        )}
        {(page > 1 || hasMore) && (
          <nav className="flex gap-3" aria-label="Pagination">
            {page > 1 && (
              <Link
                to="/funding"
                search={{
                  ...search,
                  page: page - 1 === 1 ? undefined : page - 1,
                }}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Newer
              </Link>
            )}
            {hasMore && (
              <Link
                to="/funding"
                search={{ ...search, page: page + 1 }}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Older
              </Link>
            )}
          </nav>
        )}
      </section>
    </div>
  );
}

function FundingHistory({ roundId }: { roundId: number }) {
  const [detail, setDetail] =
    useState<Awaited<ReturnType<typeof getFundingRoundDetails>>>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setBusy(true);
    setError(null);
    try {
      const next = await getFundingRoundDetails({ data: { id: roundId } });
      if (!next)
        throw new Error("This round is no longer public. Refresh the page.");
      setDetail(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load history");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="mt-3 text-sm"
      onToggle={(event) => {
        if (event.currentTarget.open && !detail && !busy && !error) void load();
      }}
    >
      <summary className="cursor-pointer font-mono text-xs underline">
        Sources and version history
      </summary>
      {busy && (
        <p role="status" className="mt-2">
          Loading history…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2">
          {error}{" "}
          <button
            type="button"
            className="underline"
            disabled={busy}
            onClick={() => void load()}
          >
            Retry
          </button>
        </p>
      )}
      {detail && (
        <div className="mt-2 space-y-3">
          {detail.corrections.map((correction, index) => (
            <p key={index} className="border-l-4 border-sec pl-2">
              Correction: {correction.body}
            </p>
          ))}
          <ol className="space-y-2">
            {detail.versions.map((version) => (
              <li key={version.id}>
                <p className="font-semibold">
                  Version #{version.id}:{" "}
                  {money(version.amount, version.currency)}
                </p>
                <p>
                  {version.roundName} ·{" "}
                  {version.investors.join(", ") || "Investors undisclosed"}
                </p>
                <ul>
                  {version.sources.map((source) => (
                    <li key={source.articleId}>
                      <a
                        href={source.url}
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        {source.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      )}
    </details>
  );
}
