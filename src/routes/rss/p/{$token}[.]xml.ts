import { createFileRoute } from "@tanstack/react-router";
import { serveReaderFeed } from "../../../server/reader-watch/feed";

export const Route = createFileRoute("/rss/p/{$token}.xml")({
  server: {
    handlers: {
      GET: ({ params }) => serveReaderFeed(params.token),
    },
  },
});
