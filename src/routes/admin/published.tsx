import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PublishedList } from "../../components/admin/ReviewRows";
import { describeError } from "../../components/admin/errors";
import { decideReview, listPublishedArticles } from "../../server/admin/review";

export const Route = createFileRoute("/admin/published")({
  ssr: "data-only",
  loader: async () => ({ published: await listPublishedArticles() }),
  component: AdminPublishedPage,
});

function AdminPublishedPage() {
  const { published } = Route.useLoaderData();
  const router = useRouter();
  const [workingId, setWorkingId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Remove = a "rejected" decision on the current body (#87 A3b).
  async function handleRemove(art: { id: number; bodySha: string }) {
    setWorkingId(art.id);
    setErrorMessage(null);
    try {
      await decideReview({
        data: {
          articleId: art.id,
          bodySha: art.bodySha,
          decision: "rejected",
        },
      });
      await router.invalidate();
    } catch (err) {
      setErrorMessage(await describeError(err));
      await router.invalidate();
    } finally {
      setWorkingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold tracking-tight">Published</h1>
      {errorMessage && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}
      <PublishedList
        published={published}
        workingId={workingId}
        onRemove={handleRemove}
      />
    </div>
  );
}
