import { formatUtc } from "../lib/time";
import type { ArticleView } from "../server/publication/articles";
import { Badge } from "./ui/badge";

function Time({ ms, label }: { ms: number; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>{" "}
      <time dateTime={new Date(ms).toISOString()}>{formatUtc(ms)}</time>
    </span>
  );
}

export function ArticleCard({ article: a }: { article: ArticleView }) {
  // The read layer returns null for anything but an http(s) URL. The title
  // links the reader page (#86), which always exists for a listed article.
  const href = a.url;
  return (
    <article
      data-section={a.sectionSlug}
      className="border-b pt-1 pb-4 last:border-b-0"
    >
      <h2 className="font-heading text-xl font-semibold leading-tight tracking-tight sm:text-[1.55rem]">
        <a href={`/a/${a.id}`} className="hover:underline">
          {a.title}
        </a>
      </h2>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] leading-snug text-muted-foreground">
        <strong className="font-semibold text-foreground">
          {a.sourceName}
        </strong>
        {a.publishedAt !== null && (
          <Time ms={a.publishedAt} label="Published" />
        )}
        <Time ms={a.fetchedAt} label="Fetched" />
      </p>
      {a.evidence.length > 0 && (
        <ul
          aria-label="Evidence labels"
          className="mt-1.5 flex flex-wrap gap-1.5"
        >
          {a.evidence.map((tag) => (
            <li key={tag}>
              <Badge
                variant="outline"
                className="rounded-none border border-border-strong text-[0.72rem] font-normal text-muted-foreground capitalize"
              >
                {tag.replaceAll("_", " ")}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {a.summary && (
        <p className="mt-1.5 line-clamp-6 font-serif text-[1.0625rem] leading-[1.65]">
          {a.summary}
        </p>
      )}
      {a.correction && (
        <p className="mt-2 border border-destructive px-2 py-1 text-sm leading-snug">
          <strong className="mr-1.5 text-[0.68rem] font-bold text-destructive">
            Correction
          </strong>
          {a.correction}
        </p>
      )}
      {(a.eventId !== null || href) && (
        <div
          data-entry-row
          className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm"
        >
          {a.eventId !== null && (
            <a
              href={`/e/${a.eventId}`}
              className="font-heading text-[1.0625rem] font-semibold text-foreground underline"
            >
              {a.eventReportCount >= 2
                ? `View story · ${a.eventReportCount} reports →`
                : "Story brief & explainers →"}
            </a>
          )}
          {href && (
            <a
              href={href}
              rel="noopener noreferrer"
              className="text-muted-foreground underline"
            >
              {`Read the original at ${a.sourceName} ↗`}
            </a>
          )}
        </div>
      )}
    </article>
  );
}
