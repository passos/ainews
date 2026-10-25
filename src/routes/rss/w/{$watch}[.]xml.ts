import { createFileRoute } from "@tanstack/react-router";
import { serveWatchFeed } from "../../../server/publication/rss";

export const Route = createFileRoute("/rss/w/{$watch}.xml")({
  server: {
    handlers: {
      GET: ({ params }) => serveWatchFeed(params.watch),
    },
  },
});
