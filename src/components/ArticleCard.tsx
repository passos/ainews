import { formatUtc } from "../lib/time";
import type { ArticleView } from "../server/publication/articles";
import { Badge } from "./ui/badge";

function Time({ ms, label }: { ms: number; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="uppercase tracking-wider text-muted-foreground">
        {label}
      </span>{" "}
      <time dateTime={new Date(ms).toISOString()}>{formatUtc(ms)}</time>
    </span>
  );
}

export function ArticleCard({ article: a }: { article: ArticleView }) {
  // The read layer returns null for anything but an http(s) URL.
  const href = a.url;
  return (
    <article
      data-section={a.sectionSlug}
      className="border-l-[5px] border-sec bg-card py-2.5 pl-3 pr-3"
    >
      <h2 className="font-serif text-lg font-bold leading-snug sm:text-xl">
        {href ? (
          <a
            href={href}
            rel="noopener noreferrer"
            aria-label={`${a.title} (opens original at ${a.sourceName})`}
            className="decoration-sec decoration-2 hover:underline"
          >
            {a.title}
            <span
              aria-hidden="true"
              className="ml-1 font-mono text-sm text-sec-ink"
            >
              ↗
            </span>
          </a>
        ) : (
          a.title
        )}
      </h2>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[0.72rem] leading-snug">
        <strong className="uppercase tracking-wider text-sec-ink">
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
                className="rounded-sm border-2 border-foreground/70 font-mono text-[0.66rem] font-semibold uppercase tracking-wider"
              >
                {tag.replaceAll("_", " ")}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {a.summary && (
        <p className="mt-1.5 line-clamp-6 text-[0.95rem] leading-snug">
          {a.summary}
        </p>
      )}
      {a.correction && (
        <p className="mt-2 border-2 border-destructive px-2 py-1 text-sm leading-snug">
          <strong className="mr-1.5 font-mono text-[0.68rem] font-bold uppercase tracking-widest text-destructive">
            Correction
          </strong>
          {a.correction}
        </p>
      )}
    </article>
  );
}
