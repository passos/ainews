// The reader page body (#86). Pure display: the page gets sanitised HTML from
// the read layer; markdown-it stays on the server.
import { formatUtc } from "../lib/time";
import type { ArticlePage } from "../server/publication/articles";
import { Disclaimer } from "./Disclaimer";

export const AI_SUMMARY_LABEL = "AI summary";

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

function summaryLabel(page: ArticlePage): string {
  switch (page.summaryKind) {
    case "ai":
      return page.editorApproved
        ? `${AI_SUMMARY_LABEL} · editor-approved`
        : AI_SUMMARY_LABEL;
    case "editor":
      return "Editor's summary";
    case "feed":
      return `Summary from ${page.article.sourceName}`;
  }
}

function OriginalLink({
  url,
  sourceName,
}: {
  url: string;
  sourceName: string;
}) {
  return (
    <p className="font-mono text-xs font-bold">
      <a
        href={url}
        rel="noopener noreferrer"
        className="text-sec-ink underline decoration-sec decoration-2"
      >
        {`Read the original at ${sourceName} ↗`}
      </a>
    </p>
  );
}

export function ArticleReader({ page }: { page: ArticlePage }) {
  const a = page.article;
  return (
    <article data-section={a.sectionSlug} className="flex flex-col gap-3 pt-4">
      <h1 className="font-serif text-2xl font-black leading-tight sm:text-3xl">
        {a.title}
      </h1>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[0.72rem] leading-snug">
        <strong className="uppercase tracking-wider text-sec-ink">
          {a.sourceName}
        </strong>
        {a.publishedAt !== null && (
          <Time ms={a.publishedAt} label="Published" />
        )}
        <Time ms={a.fetchedAt} label="Fetched" />
      </p>
      {a.url && <OriginalLink url={a.url} sourceName={a.sourceName} />}
      {a.sectionDisclaimer && <Disclaimer text={a.sectionDisclaimer} />}
      {a.correction && (
        <p className="border-2 border-destructive px-2 py-1 text-sm leading-snug">
          <strong className="mr-1.5 font-mono text-[0.68rem] font-bold uppercase tracking-widest text-destructive">
            Correction
          </strong>
          {a.correction}
        </p>
      )}
      {a.summary && (
        <section
          aria-label="Summary"
          className="max-w-[68ch] border-l-[5px] border-sec bg-card py-2 pl-3 pr-3"
        >
          <p className="font-mono text-[0.68rem] font-bold uppercase tracking-widest text-sec-ink">
            {summaryLabel(page)}
          </p>
          <p className="mt-1 text-[0.98rem] leading-snug">{a.summary}</p>
        </section>
      )}
      {page.bodyHtml && page.bodyIsAbstract && (
        <header className="max-w-[68ch]">
          <h2 className="font-serif text-lg font-bold">Abstract</h2>
          <p className="font-mono text-[0.68rem] text-muted-foreground">
            {`Original text by the authors, as published by ${a.sourceName}.`}
          </p>
        </header>
      )}
      {page.bodyHtml && (
        <div
          className="article-body"
          dangerouslySetInnerHTML={{ __html: page.bodyHtml }}
        />
      )}
      {page.excerpted && a.url && (
        <p className="font-mono text-xs font-bold">
          <a
            href={a.url}
            rel="noopener noreferrer"
            className="text-sec-ink underline decoration-sec decoration-2"
          >
            Continue reading the original ↗
          </a>
        </p>
      )}
      {a.url && (
        <footer className="border-t border-border pt-3">
          <OriginalLink url={a.url} sourceName={a.sourceName} />
        </footer>
      )}
    </article>
  );
}
