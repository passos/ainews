import { Link } from "@tanstack/react-router";
import type {
  PendingArticleView,
  PublishedArticleView,
} from "../../server/admin/ops";
import { RemoveButton } from "./RemoveButton";

// #87 A4: a review row is a two-column grid. The left column (title, meta)
// wraps freely; the buttons sit top-right and never wrap, however long the
// title is.
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3";
const ROW_MAIN = "flex min-w-0 flex-col gap-1 break-words";
const ROW_BUTTONS =
  "flex items-center gap-2 self-start shrink-0 whitespace-nowrap";

export function PendingRow({
  art,
  working,
  onDecide,
}: {
  art: PendingArticleView;
  working: boolean;
  onDecide: (
    articleId: number,
    bodySha: string,
    decision: "approved" | "rejected",
  ) => void;
}) {
  const bodySha = art.bodySha;
  return (
    <div
      className={`${ROW_GRID} rounded-lg border bg-card p-4 transition-colors hover:border-foreground/30`}
    >
      <div className={ROW_MAIN}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">
            {art.industryName}
          </span>
          {art.score !== null && (
            <span className="text-xs font-mono text-muted-foreground">
              Score: {art.score}
            </span>
          )}
          <span className="text-xs font-mono text-muted-foreground">
            ID: #{art.id}
          </span>
        </div>
        <Link
          to="/admin/articles/$articleId"
          params={{ articleId: String(art.id) }}
          className="font-serif text-base font-bold hover:underline"
        >
          {art.title}
        </Link>
      </div>
      <div className={ROW_BUTTONS}>
        <button
          type="button"
          disabled={working || !bodySha}
          onClick={() => bodySha && onDecide(art.id, bodySha, "approved")}
          className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={working || !bodySha}
          onClick={() => bodySha && onDecide(art.id, bodySha, "rejected")}
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50"
        >
          Reject
        </button>
      </div>

      {art.summary && (
        <p className="col-span-2 text-sm text-muted-foreground line-clamp-3">
          {art.summary}
        </p>
      )}

      <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-4">
          <a
            href={art.canonicalUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            Source Link &rarr;
          </a>
          {art.tags && <span>Tags: {art.tags}</span>}
        </div>
        <span className="font-mono text-[0.7rem]">
          body_sha: {art.bodySha?.slice(0, 12)}...
        </span>
      </div>
    </div>
  );
}

export function PublishedRow({
  art,
  working,
  onRemove,
}: {
  art: PublishedArticleView;
  working: boolean;
  onRemove: () => void | Promise<void>;
}) {
  return (
    <div className={`${ROW_GRID} p-3 text-sm`}>
      <div className={ROW_MAIN}>
        <Link
          to="/admin/articles/$articleId"
          params={{ articleId: String(art.id) }}
          className="font-medium hover:underline"
        >
          {art.title}
        </Link>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-2 py-0.5 font-medium">
            {art.industryName}
          </span>
          <span className="font-mono">
            {new Date(art.publishedAt ?? art.fetchedAt).toLocaleString()}
          </span>
        </div>
      </div>
      {/* The confirm sentence may wrap; the buttons may not. */}
      <div className={`${ROW_BUTTONS} [&_p]:max-w-xs [&_p]:whitespace-normal`}>
        <RemoveButton working={working} onConfirm={onRemove} />
      </div>
    </div>
  );
}

/** The Published list: approved articles on the public site, newest first. */
export function PublishedList({
  published,
  workingId,
  onRemove,
}: {
  published: PublishedArticleView[];
  workingId: number | null;
  onRemove: (art: PublishedArticleView) => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">
          Published ({published.length})
        </h2>
        <p className="text-xs text-muted-foreground">
          Approved articles on the public site, newest first (up to 100).
        </p>
      </div>
      {published.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No published articles.
        </div>
      ) : (
        <div className="flex flex-col divide-y rounded-md border">
          {published.map((art) => (
            <PublishedRow
              key={art.id}
              art={art}
              working={workingId === art.id}
              onRemove={() => onRemove(art)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
