import { Suspense } from "react";
import { Await, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getSiteInfo } from "../server/publication/site";

const searchSchema = z.object({
  audience: z
    .enum(["student", "educator", "professional"])
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  loader: async () => ({
    site: await getSiteInfo(),
    // Not awaited: streamed to the client after the shell.
    later: getSiteInfo(),
  }),
  component: Home,
});

function Home() {
  const { site, later } = Route.useLoaderData();
  return (
    <main>
      <h1>{site.name}</h1>
      <p>Placeholder. Content comes later.</p>
      <Suspense fallback={<p>Loading…</p>}>
        <Await promise={later}>{(info) => <p>Streamed: {info.name}</p>}</Await>
      </Suspense>
    </main>
  );
}
