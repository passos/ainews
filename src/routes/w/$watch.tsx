import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { Disclaimer } from "../../components/Disclaimer";
import { FollowButton } from "../../components/FollowButton";
import { getWatch } from "../../server/publication/api";

export const Route = createFileRoute("/w/$watch")({
  loader: async ({ params }) => {
    const data = await getWatch({ data: { slug: params.watch } });
    if (!data) throw notFound();
    return { data };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `Watch: ${loaderData.data.watch.question} — Personal News`
          : "Topic Watch — Personal News",
      },
    ],
    links: loaderData
      ? [
          {
            rel: "alternate",
            type: "application/rss+xml",
            title: `RSS — ${loaderData.data.watch.question}`,
            href: `/rss/w/${loaderData.data.watch.slug}.xml`,
          },
        ]
      : [],
  }),
  component: WatchPage,
});

function WatchPage() {
  const { data } = Route.useLoaderData();
  const { watch, hits } = data;

  return (
    <div className="flex flex-col gap-8 pt-4">
      {/* Header */}
      <header className="flex flex-col gap-4 border-b-2 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="bg-primary/10 text-primary font-mono text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded">
              Topic Watch
            </span>
            {watch.industryName && (
              <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">
                in {watch.industryName}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <a
              href={`/rss/w/${watch.slug}.xml`}
              className="font-mono text-xs font-bold uppercase tracking-wider underline hover:text-primary"
            >
              RSS Feed
            </a>
            <FollowButton slug={watch.slug} kind="watch" />
          </div>
        </div>

        <h1 className="font-serif text-3xl font-black tracking-tight text-foreground md:text-4xl">
          {watch.question}
        </h1>

        <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 font-mono text-xs text-muted-foreground sm:grid-cols-2">
          <div>
            <span className="font-bold uppercase tracking-wider text-foreground">
              Criterion for Update:
            </span>
            <p className="mt-1 font-sans text-sm text-foreground">
              {watch.criteria}
            </p>
          </div>
          <div>
            <span className="font-bold uppercase tracking-wider text-foreground">
              Keywords Watched:
            </span>
            <div className="mt-1 flex flex-wrap gap-1.5 font-sans">
              {watch.keywords.map((kw, i) => (
                <span
                  key={i}
                  className="rounded border bg-background px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {kw}
                </span>
              ))}
            </div>
          </div>
        </div>
      </header>

      {watch.industryDisclaimer && (
        <Disclaimer text={watch.industryDisclaimer} />
      )}

      {/* Material Developments Timeline */}
      <section className="flex flex-col gap-6">
        <div className="flex items-baseline justify-between border-b pb-2">
          <h2 className="font-mono text-sm font-black uppercase tracking-wider text-sec-ink">
            Material Developments ({hits.length})
          </h2>
          <span className="font-mono text-xs text-muted-foreground">
            Updates triggered only when new material facts emerge
          </span>
        </div>

        {hits.length === 0 ? (
          <div className="rounded-lg border border-dashed py-12 text-center font-mono text-sm text-muted-foreground">
            No material developments recorded yet. Topic is actively monitored
            against incoming reporting.
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {hits.map((hit) => (
              <article
                key={hit.id}
                className="flex flex-col gap-3 rounded-lg border p-5 shadow-xs transition-colors hover:border-primary/40"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-xs font-mono text-muted-foreground">
                  <span className="font-semibold text-primary">
                    {new Date(hit.hitAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span>Revision #{hit.eventRevision}</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    What's New:
                  </span>
                  <p className="font-serif text-lg font-bold leading-snug text-foreground">
                    {hit.summary}
                  </p>
                </div>

                <div className="mt-1 flex flex-col gap-2 rounded bg-muted/40 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-muted-foreground">
                      Associated Event:
                    </span>
                    <Link
                      to="/e/$eventId"
                      params={{ eventId: String(hit.eventId) }}
                      className="font-mono text-xs font-bold text-sec-ink underline"
                    >
                      View Event Story & Evidence →
                    </Link>
                  </div>
                  <span className="font-medium text-sm text-foreground">
                    {hit.eventTitle}
                  </span>

                  {hit.articles.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1 border-t pt-2">
                      <span className="font-mono text-[11px] font-bold text-muted-foreground uppercase">
                        Reporting Sources:
                      </span>
                      <ul className="flex flex-col gap-1 text-xs">
                        {hit.articles.map((art) => (
                          <li
                            key={art.id}
                            className="flex items-baseline gap-2"
                          >
                            <span className="font-mono text-muted-foreground">
                              [{art.sourceName}]
                            </span>
                            {art.url ? (
                              <a
                                href={art.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sec-ink underline hover:text-primary truncate"
                              >
                                {art.title}
                              </a>
                            ) : (
                              <span className="truncate">{art.title}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
