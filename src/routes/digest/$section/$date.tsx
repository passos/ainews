import { Suspense } from "react";
import { Await, Link, createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { Disclaimer } from "../../../components/Disclaimer";
import { getDigest, getRecentDigests } from "../../../server/publication/api";
import type {
  DigestView,
  RecentDigestLink,
} from "../../../server/publication/digests";
import { SITE_NAME } from "../../../lib/site";

const digestSearchSchema = z.object({
  kind: z.enum(["daily", "weekly"]).optional().catch(undefined),
});

export interface LoadDigestFns {
  getDigest?: (
    slug: string,
    date: string,
    kind?: "daily" | "weekly",
  ) => Promise<DigestView | null>;
  getRecentDigests?: (
    slug: string,
    kind?: "daily" | "weekly",
  ) => Promise<RecentDigestLink[]>;
}

export async function loadDigest(
  params: { section: string; date: string },
  kindOrFns?: "daily" | "weekly" | LoadDigestFns,
  maybeFns?: LoadDigestFns,
) {
  const kind = typeof kindOrFns === "string" ? kindOrFns : "daily";
  const customFns =
    typeof kindOrFns === "object" && kindOrFns !== null ? kindOrFns : maybeFns;

  const fns = {
    getDigest:
      customFns?.getDigest ??
      ((slug: string, date: string, k?: "daily" | "weekly") =>
        getDigest({ data: { slug, date, kind: k } })),
    getRecentDigests:
      customFns?.getRecentDigests ??
      ((slug: string, k?: "daily" | "weekly") =>
        getRecentDigests({ data: { slug, kind: k } })),
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    throw notFound();
  }
  const data = await fns.getDigest(params.section, params.date, kind);
  if (!data) throw notFound();

  return {
    data,
    recent: fns.getRecentDigests(params.section, kind),
  };
}

export const Route = createFileRoute("/digest/$section/$date")({
  validateSearch: (search) => digestSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ kind: search.kind ?? "daily" }),
  loader: ({ params, deps }) => loadDigest(params, deps.kind),
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: SITE_NAME }] };
    const isWeekly = loaderData.data.kind === "weekly";
    const kindLabel = isWeekly ? "Weekly Digest" : "Daily Digest";
    const dateLabel = isWeekly
      ? `Week of ${loaderData.data.periodStart}`
      : loaderData.data.periodStart;
    return {
      meta: [
        {
          title: `${loaderData.data.section.name} ${kindLabel} (${dateLabel}) — ${SITE_NAME}`,
        },
      ],
      links: [
        {
          rel: "alternate",
          type: "application/rss+xml",
          title: `${SITE_NAME} — ${loaderData.data.section.name} ${kindLabel}`,
          href: `/rss/digest/${loaderData.data.section.slug}.xml`,
        },
      ],
    };
  },
  notFoundComponent: () => <p className="pt-6 text-sm">No such digest.</p>,
  component: DigestPage,
});

function DigestPage() {
  const { data, recent } = Route.useLoaderData();
  const { section, items, intro, periodStart, kind } = data;
  const isWeekly = kind === "weekly";

  return (
    <div data-section={section.slug} className="flex flex-col gap-4 pt-4">
      <nav aria-label="Breadcrumb">
        <Link
          to="/s/$section"
          params={{ section: section.slug }}
          className="text-xs font-bold text-foreground hover:underline"
        >
          ← {section.name}
        </Link>
      </nav>

      <div className="flex flex-wrap items-baseline justify-between gap-3 border-t-[3px] border-foreground pt-1">
        <h1 className="font-heading text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">
          {section.name} {isWeekly ? "Weekly Digest" : "Daily Digest"} ·{" "}
          {isWeekly ? `Week of ${periodStart}` : periodStart}
        </h1>
        <div className="flex items-center gap-3">
          <a
            href={`/rss/digest/${section.slug}.xml`}
            className="text-xs font-bold underline"
          >
            Digest RSS
          </a>
        </div>
      </div>

      {section.disclaimer && <Disclaimer text={section.disclaimer} />}

      {intro ? (
        <section
          aria-label={isWeekly ? "Weekly synthesis" : "Daily synthesis"}
          className="border-l-[3px] border-foreground py-1 pl-5 font-sans text-sm leading-relaxed"
        >
          <h2 className="mb-1 text-xs font-bold text-muted-foreground">
            Executive Summary
          </h2>
          <p className="text-foreground">{intro}</p>
        </section>
      ) : null}

      <div className="flex flex-col gap-4">
        <h2 className="text-xs font-bold text-muted-foreground">
          Top Developments ({items.length})
        </h2>

        {items.length === 0 ? (
          <p className="border border-dashed px-3 py-4 text-xs text-muted-foreground">
            No approved events for this {isWeekly ? "week" : "day"}.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {items.map((item, idx) => (
              <li key={item.eventId} className="flex flex-col gap-1 border p-4">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-bold text-muted-foreground">
                    #{idx + 1}
                  </span>
                  <Link
                    to="/e/$eventId"
                    params={{ eventId: String(item.eventId) }}
                    className="font-heading text-lg font-semibold text-foreground hover:text-muted-foreground hover:underline tracking-tight"
                  >
                    {item.title}
                  </Link>
                </div>
                <p className="text-sm text-foreground/90 leading-relaxed">
                  {item.oneLiner}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[0.72rem] text-muted-foreground">
                  <span>Source: {item.sourceName}</span>
                  <span>·</span>
                  <span>
                    {item.articleCount} report
                    {item.articleCount > 1 ? "s" : ""}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <aside className="mt-6 border-t pt-4">
        <h3 className="mb-2 text-xs font-bold text-muted-foreground">
          Recent {section.name} {isWeekly ? "Weekly" : "Daily"} Digests
        </h3>
        <Suspense fallback={null}>
          <Await promise={recent}>
            {(digests) =>
              digests.length <= 1 ? (
                <p className="text-xs text-muted-foreground">
                  No other recent digests.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-3 text-xs">
                  {digests
                    .filter((d) => d.date !== periodStart)
                    .map((d) => (
                      <li key={d.date}>
                        <Link
                          to="/digest/$section/$date"
                          params={{ section: section.slug, date: d.date }}
                          search={isWeekly ? { kind: "weekly" } : undefined}
                          className="underline hover:text-muted-foreground"
                        >
                          {d.date}
                        </Link>
                      </li>
                    ))}
                </ul>
              )
            }
          </Await>
        </Suspense>
      </aside>
    </div>
  );
}
