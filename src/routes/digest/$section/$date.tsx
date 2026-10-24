import { Suspense } from "react";
import { Await, Link, createFileRoute, notFound } from "@tanstack/react-router";
import { Disclaimer } from "../../../components/Disclaimer";
import { getDigest, getRecentDigests } from "../../../server/publication/api";

export async function loadDigest(
  params: { section: string; date: string },
  fns = {
    getDigest: (slug: string, date: string) =>
      getDigest({ data: { slug, date } }),
    getRecentDigests: (slug: string) => getRecentDigests({ data: { slug } }),
  },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    throw notFound();
  }
  const data = await fns.getDigest(params.section, params.date);
  if (!data) throw notFound();

  return {
    data,
    recent: fns.getRecentDigests(params.section),
  };
}

export const Route = createFileRoute("/digest/$section/$date")({
  loader: ({ params }) => loadDigest(params),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.data.section.name} Daily Digest (${loaderData.data.periodStart}) — Personal News`
          : "Personal News",
      },
    ],
    links: loaderData
      ? [
          {
            rel: "alternate",
            type: "application/rss+xml",
            title: `Personal News — ${loaderData.data.section.name} Daily Digest`,
            href: `/rss/digest/${loaderData.data.section.slug}.xml`,
          },
        ]
      : [],
  }),
  notFoundComponent: () => (
    <p className="pt-6 font-mono text-sm uppercase tracking-wider">
      No such daily digest.
    </p>
  ),
  component: DigestPage,
});

function DigestPage() {
  const { data, recent } = Route.useLoaderData();
  const { section, items, intro, periodStart } = data;

  return (
    <div data-section={section.slug} className="flex flex-col gap-4 pt-4">
      <nav aria-label="Breadcrumb">
        <Link
          to="/s/$section"
          params={{ section: section.slug }}
          className="font-mono text-xs font-bold uppercase tracking-wider text-sec-ink hover:underline"
        >
          ← {section.name}
        </Link>
      </nav>

      <div className="flex flex-wrap items-baseline justify-between gap-3 border-t-[5px] border-sec pt-1">
        <h1 className="font-serif text-2xl font-black uppercase tracking-tight text-sec-ink sm:text-3xl">
          {section.name} Daily Digest · {periodStart}
        </h1>
        <div className="flex items-center gap-3">
          <a
            href={`/rss/digest/${section.slug}.xml`}
            className="font-mono text-xs font-bold uppercase tracking-wider underline"
          >
            Digest RSS
          </a>
        </div>
      </div>

      {section.disclaimer && <Disclaimer text={section.disclaimer} />}

      {intro ? (
        <section
          aria-label="Daily synthesis"
          className="border-l-4 border-sec bg-muted/40 p-4 font-sans text-sm leading-relaxed"
        >
          <h2 className="mb-1 font-mono text-xs font-bold uppercase tracking-wider text-sec-ink">
            Executive Summary
          </h2>
          <p className="text-foreground">{intro}</p>
        </section>
      ) : null}

      <div className="flex flex-col gap-4">
        <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Top Developments ({items.length})
        </h2>

        {items.length === 0 ? (
          <p className="border-2 border-dashed px-3 py-4 font-mono text-xs uppercase tracking-wider text-muted-foreground">
            No approved events for this day.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {items.map((item, idx) => (
              <li
                key={item.eventId}
                className="flex flex-col gap-1 rounded-sm border p-4 shadow-xs"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs font-bold text-muted-foreground">
                    #{idx + 1}
                  </span>
                  <Link
                    to="/e/$eventId"
                    params={{ eventId: String(item.eventId) }}
                    className="font-serif text-lg font-bold text-foreground hover:text-sec-ink hover:underline"
                  >
                    {item.title}
                  </Link>
                </div>
                <p className="text-sm text-foreground/90 leading-relaxed">
                  {item.oneLiner}
                </p>
                <div className="mt-1 flex items-center gap-2 font-mono text-[0.72rem] text-muted-foreground">
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
        <h3 className="mb-2 font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Recent {section.name} Digests
        </h3>
        <Suspense fallback={null}>
          <Await promise={recent}>
            {(digests) =>
              digests.length <= 1 ? (
                <p className="font-mono text-xs text-muted-foreground">
                  No other recent digests.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-3 font-mono text-xs">
                  {digests
                    .filter((d) => d.date !== periodStart)
                    .map((d) => (
                      <li key={d.date}>
                        <Link
                          to="/digest/$section/$date"
                          params={{ section: section.slug, date: d.date }}
                          className="underline hover:text-sec-ink"
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
