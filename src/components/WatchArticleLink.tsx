import type { WatchHitItem } from "../server/publication/watches";

export function WatchArticleLink({
  article: art,
}: {
  article: WatchHitItem["articles"][number];
}) {
  // The title links the reader page (#86). The read layer already passed
  // the original URL through safeHttpUrl, so it is http(s) or null.
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-muted-foreground">[{art.sourceName}]</span>
      <a
        href={`/a/${art.id}`}
        className="text-foreground underline hover:text-primary wrap-anywhere"
      >
        {art.title}
      </a>
      {art.url && (
        <a
          href={art.url}
          rel="noopener noreferrer"
          className="font-bold text-foreground hover:underline"
        >
          {`Read the original at ${art.sourceName} ↗`}
        </a>
      )}
    </li>
  );
}
