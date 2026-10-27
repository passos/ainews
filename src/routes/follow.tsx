import { createFileRoute } from "@tanstack/react-router";
import { FollowPanel } from "../components/FollowForm";
import { resolveFollowShell } from "../lib/follow";
import { SITE_NAME } from "../lib/site";
import { getSiteShell } from "../server/publication/site";
import {
  createReaderWatch,
  revokeReaderWatch,
} from "../server/reader-watch/api";

export const Route = createFileRoute("/follow")({
  // 404 while READER_WATCH_ENABLED is not "true". Sections come without Finance.
  loader: async () => resolveFollowShell(await getSiteShell()),
  head: () => ({
    meta: [
      { title: `Follow your own question — ${SITE_NAME}` },
      { name: "robots", content: "noindex" },
    ],
  }),
  notFoundComponent: () => <p className="pt-6 text-sm">No such page.</p>,
  component: FollowPage,
});

function FollowPage() {
  const { sections } = Route.useLoaderData();
  return (
    <section
      aria-labelledby="follow-title"
      className="flex max-w-2xl flex-col gap-3 pt-4"
    >
      <h1
        id="follow-title"
        className="border-t-[3px] border-foreground pt-1 text-sm font-semibold"
      >
        Follow your own question
      </h1>
      <p className="text-sm text-muted-foreground">
        Ask one question and say what counts as real progress. You get a private
        RSS address. It lists a story only when newly approved reporting meets
        your criteria.
      </p>
      <FollowPanel
        sections={sections}
        onCreate={(input) => createReaderWatch({ data: input })}
        onRevoke={(token) => revokeReaderWatch({ data: { token } })}
      />
    </section>
  );
}
