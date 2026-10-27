import { Suspense } from "react";
import { Await, Link, createFileRoute } from "@tanstack/react-router";
import { ArticleCard } from "../components/ArticleCard";
import { Disclaimer } from "../components/Disclaimer";
import { YourSections } from "../components/YourSections";
import { formatUtc } from "../lib/time";
import { getHome, getRecentCorrections } from "../server/publication/api";

export const Route = createFileRoute("/")({
  loader: async () => ({
    home: await getHome(),
    // Not awaited: streamed to the client after the shell.
    corrections: getRecentCorrections(),
  }),
  component: Home,
});

function Home() {
  const { home, corrections } = Route.useLoaderData();
  return (
    <div className="flex flex-col gap-4 pt-4">
      <YourSections sections={home.sections} watches={home.watches} />
      <div className="space-y-6 lg:columns-2 lg:gap-x-6 lg:space-y-0">
        {home.sections.map((s) => (
          <section
            key={s.slug}
            data-section={s.slug}
            aria-labelledby={`sec-${s.slug}`}
            className="mb-6 flex break-inside-avoid flex-col gap-2"
          >
            <div className="flex items-baseline justify-between gap-3 border-t-[3px] border-foreground pt-1">
              <h1
                id={`sec-${s.slug}`}
                className="text-sm font-semibold text-foreground"
              >
                {s.name}
              </h1>
              <span className="flex gap-3 text-sm text-muted-foreground">
                <Link
                  to="/s/$section"
                  params={{ section: s.slug }}
                  className="underline"
                >
                  All {s.name}
                </Link>
                <a href={`/rss/${s.slug}.xml`} className="underline">
                  RSS
                </a>
              </span>
            </div>
            {s.disclaimer && <Disclaimer text={s.disclaimer} />}
            {s.articles.length === 0 ? (
              <p className="border border-dashed px-3 py-4 text-xs text-muted-foreground">
                Nothing approved yet.
              </p>
            ) : (
              s.articles.map((a) => <ArticleCard key={a.id} article={a} />)
            )}
          </section>
        ))}
      </div>
      <Suspense fallback={null}>
        <Await promise={corrections}>
          {(list) =>
            list.length === 0 ? null : (
              <section
                aria-labelledby="recent-corrections"
                className="border-t-[3px] border-destructive pt-1"
              >
                <h1
                  id="recent-corrections"
                  className="text-sm font-semibold text-destructive"
                >
                  Recent corrections
                </h1>
                <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                  {list.map((c) => (
                    <li key={c.id} className="leading-snug">
                      <time
                        dateTime={new Date(c.createdAt).toISOString()}
                        className="mr-2 text-xs text-muted-foreground"
                      >
                        {formatUtc(c.createdAt)}
                      </time>
                      <strong>{c.articleTitle}</strong>: {c.body}
                    </li>
                  ))}
                </ul>
              </section>
            )
          }
        </Await>
      </Suspense>
    </div>
  );
}
