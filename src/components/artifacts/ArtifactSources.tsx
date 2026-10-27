import { formatUtc } from "../../lib/time";
import type { ArtifactSourceView } from "../../server/publication/events";

export function ArtifactSources({
  sources,
}: {
  sources: ArtifactSourceView[];
}) {
  if (sources.length === 0) return null;
  return (
    <footer
      aria-label="Artifact sources"
      className="mt-4 border-t border-border pt-2 text-[0.72rem] leading-snug"
    >
      <h4 className="font-bold text-muted-foreground">Source articles</h4>
      <ul className="mt-1 flex flex-col gap-1.5">
        {sources.map((s) => (
          <li key={s.id} className="min-w-0">
            <a
              href={`/a/${s.id}`}
              className="wrap-anywhere font-bold hover:underline"
            >
              {s.title}
            </a>
            <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>
                Published{" "}
                {s.publishedAt === null ? (
                  "not stated"
                ) : (
                  <time dateTime={new Date(s.publishedAt).toISOString()}>
                    {formatUtc(s.publishedAt)}
                  </time>
                )}
              </span>
              <span>
                Fetched{" "}
                <time dateTime={new Date(s.fetchedAt).toISOString()}>
                  {formatUtc(s.fetchedAt)}
                </time>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </footer>
  );
}
