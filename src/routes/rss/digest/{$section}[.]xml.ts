import { createFileRoute } from "@tanstack/react-router";
import { serveDigestFeed } from "../../../server/publication/rss";

export const Route = createFileRoute("/rss/digest/{$section}.xml")({
  server: {
    handlers: {
      GET: ({ params }) => serveDigestFeed(params.section),
    },
  },
});
