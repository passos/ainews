// The reader page body (#86). Pure display: the page gets sanitised HTML from
// the read layer; markdown-it stays on the server.
import { firstSentence } from "../lib/first-sentence";
import { formatUtc } from "../lib/time";
import type { ArticlePage } from "../server/publication/articles";
import { Disclaimer } from "./Disclaimer";

export const AI_SUMMARY_LABEL = "AI summary";

function Time({ ms }: { ms: number }) {
  return <time dateTime={new Date(ms).toISOString()}>{formatUtc(ms)}</time>;
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

// Only the sections the story page shows (same flags as its nav).
function storyAnchors(page: ArticlePage): [string, string][] {
  const sections = page.event?.sections;
  if (!sections) return [];
  const out: [string, string][] = [];
  if (sections.brief) out.push(["brief", "Brief"]);
  if (sections.evidenceClaims > 0) {
    const n = sections.evidenceClaims;
    out.push(["evidence", `Evidence · ${n} ${n === 1 ? "claim" : "claims"}`]);
  }
  if (sections.explain) out.push(["explain", "Explain"]);
  if (sections.ask) out.push(["ask", "Ask"]);
  return out;
}

export function ArticleReader({ page }: { page: ArticlePage }) {
  const a = page.article;
  const anchors = storyAnchors(page);
  return (
    <article data-section={a.sectionSlug} className="flex w-full flex-col pt-4">
      <header className="flex flex-col gap-3 border-b pb-5 pt-2">
        <a
          href={`/s/${a.sectionSlug}`}
          className="text-[0.8125rem] font-semibold text-foreground no-underline hover:underline"
        >
          {a.sectionName}
        </a>
        <h1 className="font-heading text-3xl font-semibold leading-[1.08] tracking-[-0.02em] sm:text-[2.75rem]">
          {a.title}
        </h1>
      </header>
      <div className="grid gap-8 pt-7 min-[860px]:grid-cols-[minmax(0,42rem)_minmax(0,1fr)] min-[860px]:gap-14">
        <div className="flex min-w-0 flex-col gap-3">
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
              <p className="mt-1 font-serif text-lg leading-[1.6]">
                {a.summary}
              </p>
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
        </div>
        <aside
          aria-label="About this story"
          className="order-first flex min-w-0 flex-col gap-7 self-start min-[860px]:sticky min-[860px]:top-4 min-[860px]:order-none"
        >
          {a.eventId !== null && (
            <div className="flex flex-col gap-2 border-t-[3px] border-foreground pt-3">
              <span className="text-xs font-semibold text-muted-foreground">
                On Daily
              </span>
              <a
                href={`/e/${a.eventId}`}
                className="font-heading text-[1.375rem] leading-[1.2] font-semibold text-foreground no-underline hover:underline"
              >
                Story brief, explanations and{" "}
                <span className="whitespace-nowrap">evidence →</span>
              </a>
              {page.event?.whatHappened && (
                <p className="font-serif text-[0.9375rem] leading-[1.55]">
                  {firstSentence(page.event.whatHappened)}
                </p>
              )}
              {anchors.length > 0 && (
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {anchors.map(([id, label]) => (
                    <a
                      key={id}
                      href={`/e/${a.eventId}#${id}`}
                      className="text-foreground underline"
                    >
                      {label}
                    </a>
                  ))}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-col gap-2.5 border-t pt-3">
            <span className="text-xs font-semibold text-muted-foreground">
              Source
            </span>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">From</dt>
              <dd>{a.sourceName}</dd>
              {a.publishedAt !== null && (
                <>
                  <dt className="text-muted-foreground">Published</dt>
                  <dd>
                    <Time ms={a.publishedAt} />
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Fetched</dt>
              <dd>
                <Time ms={a.fetchedAt} />
              </dd>
            </dl>
            {a.url && (
              <p className="text-sm">
                <a
                  href={a.url}
                  rel="noopener noreferrer"
                  className="text-foreground underline"
                >
                  {`Read the original at ${a.sourceName} ↗`}
                </a>
              </p>
            )}
          </div>
        </aside>
      </div>
    </article>
  );
}
