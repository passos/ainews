// The reader page body (#86). Pure display: the page gets sanitised HTML from
// the read layer; markdown-it stays on the server.
import { formatUtc } from "../lib/time";
import type { ArticlePage } from "../server/publication/articles";
import { Disclaimer } from "./Disclaimer";

export const AI_SUMMARY_LABEL = "AI summary";

function Time({ ms, label }: { ms: number; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>{" "}
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
    <p className="text-xs font-bold">
      <a
        href={url}
        rel="noopener noreferrer"
        className="text-foreground underline"
      >
        {`Read the original at ${sourceName} ↗`}
      </a>
    </p>
  );
}

export function ArticleReader({ page }: { page: ArticlePage }) {
  const a = page.article;
  return (
    <article
      data-section={a.sectionSlug}
      className="mx-auto flex w-full max-w-[40rem] flex-col gap-3 pt-4"
    >
      <h1 className="font-heading text-3xl font-semibold leading-[1.08] tracking-[-0.02em] sm:text-[2.75rem]">
        {a.title}
      </h1>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b pb-3 text-sm leading-snug text-muted-foreground">
        <strong className="font-semibold text-foreground">
          {a.sourceName}
        </strong>
        {a.publishedAt !== null && (
          <Time ms={a.publishedAt} label="Published" />
        )}
        <Time ms={a.fetchedAt} label="Fetched" />
      </p>
      {a.eventId !== null && (
        <a
          href={`/e/${a.eventId}`}
          className="group block border-y py-3 text-foreground no-underline"
        >
          <span className="block text-xs text-muted-foreground">On Daily</span>
          <span className="block font-heading text-lg font-semibold group-hover:underline">
            Story brief, explanations and evidence →
          </span>
        </a>
      )}
      {a.url && <OriginalLink url={a.url} sourceName={a.sourceName} />}
      {a.sectionDisclaimer && <Disclaimer text={a.sectionDisclaimer} />}
      {a.correction && (
        <p className="border border-destructive px-2 py-1 text-sm leading-snug">
          <strong className="mr-1.5 text-[0.68rem] font-bold text-destructive">
            Correction
          </strong>
          {a.correction}
        </p>
      )}
      {a.summary && (
        <section
          aria-label="Summary"
          className="border-l-[3px] border-foreground py-1 pl-5"
        >
          <p className="text-[0.8125rem] font-semibold text-muted-foreground">
            {summaryLabel(page)}
          </p>
          <p className="mt-1 font-serif text-lg leading-[1.6]">{a.summary}</p>
        </section>
      )}
      {page.bodyHtml && page.bodyIsAbstract && (
        <header>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">
            Abstract
          </h2>
          <p className="text-[0.8125rem] text-muted-foreground">
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
        <p className="text-xs font-bold">
          <a
            href={a.url}
            rel="noopener noreferrer"
            className="text-foreground underline"
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
