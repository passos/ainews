import { Suspense } from "react";
import { Await, Link, createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { ArticleCard } from "../../components/ArticleCard";
import { Disclaimer } from "../../components/Disclaimer";
import { FollowButton } from "../../components/FollowButton";
import { buttonVariants } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { getSection, getSectionSources } from "../../server/publication/api";

const searchSchema = z.object({
  // Unset and invalid both mean page 1; the URL is not rewritten for page 1.
  page: z.number().int().min(1).max(10_000).optional().catch(undefined),
});

export const Route = createFileRoute("/s/$section")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: async ({ params, deps }) => {
    const data = await getSection({
      data: { slug: params.section, page: deps.page },
    });
    if (!data) throw notFound();
    return {
      data,
      // Not awaited: streamed after the shell.
      sources: getSectionSources({ data: { slug: params.section } }),
    };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.data.section.name} — Personal News`
          : "Personal News",
      },
    ],
    links: loaderData
      ? [
          {
            rel: "alternate",
            type: "application/rss+xml",
            title: `Personal News — ${loaderData.data.section.name}`,
            href: `/rss/${loaderData.data.section.slug}.xml`,
          },
        ]
      : [],
  }),
  notFoundComponent: () => (
    <p className="pt-6 font-mono text-sm uppercase tracking-wider">
      No such section.
    </p>
  ),
  component: SectionPage,
});

const pagerClass = cn(
  buttonVariants({ variant: "outline", size: "sm" }),
  "rounded-sm border-2 font-mono text-xs font-bold uppercase tracking-wider",
);

function SectionPage() {
  const { data, sources } = Route.useLoaderData();
  const page = Route.useSearch().page ?? 1;
  const { section, articles, hasMore } = data;
  return (
    <div data-section={section.slug} className="flex flex-col gap-3 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t-[5px] border-sec pt-1">
        <h1 className="font-serif text-3xl font-black uppercase tracking-tight text-sec-ink sm:text-4xl">
          {section.name}
        </h1>
        <div className="flex items-center gap-3">
          {section.latestDigestDate && (
            <Link
              to="/digest/$section/$date"
              params={{
                section: section.slug,
                date: section.latestDigestDate,
              }}
              className="font-mono text-xs font-bold uppercase tracking-wider underline hover:text-sec-ink"
            >
              Daily Digest
            </Link>
          )}
          {section.latestWeeklyDigestDate && (
            <Link
              to="/digest/$section/$date"
              params={{
                section: section.slug,
                date: section.latestWeeklyDigestDate,
              }}
              search={{ kind: "weekly" }}
              className="font-mono text-xs font-bold uppercase tracking-wider underline hover:text-sec-ink"
            >
              Weekly Digest
            </Link>
          )}
          {section.slug === "finance" && (
            <Link
              to="/funding"
              className="font-mono text-xs font-bold uppercase tracking-wider underline hover:text-sec-ink"
            >
              Funding Tracker
            </Link>
          )}
          <a
            href={`/rss/${section.slug}.xml`}
            className="font-mono text-xs font-bold uppercase tracking-wider underline"
          >
            RSS
          </a>
          <FollowButton slug={section.slug} />
        </div>
      </div>
      {section.disclaimer && <Disclaimer text={section.disclaimer} />}
      <Suspense fallback={null}>
        <Await promise={sources}>
          {(list) =>
            list.length === 0 ? null : (
              <p className="font-mono text-[0.72rem] leading-relaxed">
                <span className="mr-2 font-bold uppercase tracking-widest text-muted-foreground">
                  Sources
                </span>
                {list.map((s, i) => (
                  <span key={s.name}>
                    {i > 0 && " · "}
                    {s.homepage ? (
                      <a
                        href={s.homepage}
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        {s.name}
                      </a>
                    ) : (
                      s.name
                    )}
                  </span>
                ))}
              </p>
            )
          }
        </Await>
      </Suspense>
      {articles.length === 0 ? (
        <p className="border-2 border-dashed px-3 py-4 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Nothing approved here yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {articles.map((a) => (
            <ArticleCard key={a.id} article={a} />
          ))}
        </div>
      )}
      {(page > 1 || hasMore) && (
        <nav
          aria-label="Pages"
          className="flex items-center justify-between gap-2 border-t-2 pt-3"
        >
          {page > 1 ? (
            <Link
              to="."
              search={(prev) => ({ ...prev, page: page - 1 })}
              className={pagerClass}
            >
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Page {page}
          </span>
          {hasMore ? (
            <Link
              to="."
              search={(prev) => ({ ...prev, page: page + 1 })}
              className={pagerClass}
            >
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
