import { Suspense } from "react";
import { Await, Link, createFileRoute, notFound } from "@tanstack/react-router";
import { ArticleCard } from "../../components/ArticleCard";
import { AudienceExplainCard } from "../../components/artifacts/AudienceExplainCard";
import { PaperDecoderCard } from "../../components/artifacts/PaperDecoderCard";
import { StoryBriefCard } from "../../components/artifacts/StoryBriefCard";
import { Disclaimer } from "../../components/Disclaimer";
import { InspectEvidencePanel } from "../../components/evidence/InspectEvidencePanel";
import { getEvent, getEventSources } from "../../server/publication/api";

export async function loadEvent(
  params: { eventId: string },
  fns = {
    getEvent: (eventId: number) => getEvent({ data: { eventId } }),
    getEventSources: (eventId: number) =>
      getEventSources({ data: { eventId } }),
  },
) {
  const eventId = Number(params.eventId);
  if (Number.isNaN(eventId) || eventId <= 0) throw notFound();
  const data = await fns.getEvent(eventId);
  if (!data) throw notFound();
  return {
    data,
    // Streamed after the shell
    sources: fns.getEventSources(eventId),
  };
}

export const Route = createFileRoute("/e/$eventId")({
  loader: ({ params }) => loadEvent(params),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.data.title} — Personal News`
          : "Personal News",
      },
    ],
  }),
  notFoundComponent: () => (
    <p className="pt-6 font-mono text-sm uppercase tracking-wider">
      No such event.
    </p>
  ),
  component: EventPage,
});

function EventPage() {
  const { data, sources } = Route.useLoaderData();
  const { audience } = Route.useSearch();
  const { section, articles, corrections, title, artifacts, evidence } = data;

  const hasExplanations =
    artifacts?.explanations && Object.keys(artifacts.explanations).length > 0;
  const verifiedClaims = evidence?.claims
    ?.filter((c) => c.consensusStatus === "verified")
    .map((c) => c.claimText);

  return (
    <div data-section={section.slug} className="flex flex-col gap-4 pt-4">
      <nav aria-label="Breadcrumb">
        <Link
          to="/s/$section"
          params={{ section: section.slug }}
          className="font-mono text-xs font-bold uppercase tracking-wider text-sec-ink hover:underline"
        >
          ← {section.name}
        </Link>
      </nav>

      <header className="border-t-[5px] border-sec pt-2">
        <h1 className="font-serif text-2xl font-black leading-tight sm:text-3xl">
          {title}
        </h1>
        <p className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          {articles.length} {articles.length === 1 ? "report" : "reports"} on
          this story
        </p>
      </header>

      {section.disclaimer && <Disclaimer text={section.disclaimer} />}

      {artifacts?.brief && (
        <StoryBriefCard
          brief={artifacts.brief}
          verifiedClaims={verifiedClaims}
        />
      )}

      {evidence && evidence.claims.length > 0 && (
        <InspectEvidencePanel evidence={evidence} />
      )}

      {hasExplanations && (
        <AudienceExplainCard
          explanations={artifacts.explanations}
          initialAudience={audience}
        />
      )}

      {artifacts?.decoder && <PaperDecoderCard decoder={artifacts.decoder} />}

      {corrections.length > 0 && (
        <div className="border-2 border-destructive p-3">
          <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-destructive">
            Correction
          </h2>
          <div className="mt-1 space-y-1">
            {corrections.map((corr, idx) => (
              <p key={idx} className="text-sm leading-snug">
                {corr}
              </p>
            ))}
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        <Await promise={sources}>
          {(list) =>
            list.length === 0 ? null : (
              <aside className="border-y py-2 font-mono text-[0.72rem] leading-relaxed">
                <span className="mr-2 font-bold uppercase tracking-widest text-muted-foreground">
                  Sources
                </span>
                {list.map((s, i) => (
                  <span key={s.name}>
                    {i > 0 && " · "}
                    <span>
                      {s.name} ({s.count})
                    </span>
                  </span>
                ))}
              </aside>
            )
          }
        </Await>
      </Suspense>

      <section aria-label="Story timeline" className="flex flex-col gap-3">
        <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Timeline
        </h2>
        <div className="flex flex-col gap-3">
          {articles.map((a, idx) => (
            <div key={a.id} className="flex flex-col gap-1">
              {idx === 0 && (
                <div className="flex items-center gap-1.5 font-mono text-[0.68rem] font-bold uppercase tracking-widest text-sec-ink">
                  <span>★ First seen</span>
                </div>
              )}
              <ArticleCard article={a} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
