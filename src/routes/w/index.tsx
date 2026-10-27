import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { FollowOwnLink } from "../../components/FollowForm";
import { Disclaimer } from "../../components/Disclaimer";
import { FollowButton } from "../../components/FollowButton";
import { SITE_NAME } from "../../lib/site";
import { getPublicWatches } from "../../server/publication/api";

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/w/")({
  loader: async () => ({ watches: await getPublicWatches() }),
  head: () => ({ meta: [{ title: `Topic Watches — ${SITE_NAME}` }] }),
  component: WatchListPage,
});

function WatchListPage() {
  const { watches } = Route.useLoaderData();
  const { readerWatchEnabled } = rootRoute.useLoaderData();
  return (
    <section
      aria-labelledby="watches-title"
      className="flex flex-col gap-3 pt-4"
    >
      <h1
        id="watches-title"
        className="border-t-[3px] border-foreground pt-1 text-sm font-semibold"
      >
        Topic Watches
      </h1>
      <p className="text-sm text-muted-foreground">
        Each watch follows one question. It lists a development only when newly
        approved reporting changes the answer.
      </p>
      {readerWatchEnabled && <FollowOwnLink />}
      {watches.length === 0 ? (
        <p className="border border-dashed px-3 py-4 text-xs text-muted-foreground">
          No topic watches yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {watches.map((w) => (
            <li
              key={w.id}
              data-watch={w.slug}
              className="flex flex-col gap-2 border p-3"
            >
              <Link
                to="/w/$watch"
                params={{ watch: w.slug }}
                search={(prev) => ({ audience: prev.audience })}
                className="font-heading text-lg font-semibold tracking-tight"
              >
                {w.question}
              </Link>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span>{w.industryName ?? "All sections"}</span>
                <span aria-hidden="true">·</span>
                <a href={`/rss/w/${w.slug}.xml`} className="underline">
                  RSS
                </a>
                <span aria-hidden="true">·</span>
                <FollowButton slug={w.slug} kind="watch" />
              </div>
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {w.criteria}
              </p>
              {w.industryDisclaimer && (
                <Disclaimer text={w.industryDisclaimer} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
