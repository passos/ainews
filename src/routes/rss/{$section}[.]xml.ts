import { createFileRoute } from "@tanstack/react-router";
import { serveFeed } from "../../server/publication/rss";

export const Route = createFileRoute("/rss/{$section}.xml")({
  server: {
    handlers: {
      GET: ({ params }) => serveFeed(params.section),
    },
  },
});
