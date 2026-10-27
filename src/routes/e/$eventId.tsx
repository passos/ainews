import { Suspense, type ReactNode } from "react";
import {
  Await,
  Link,
  createFileRoute,
  getRouteApi,
  notFound,
} from "@tanstack/react-router";
import { ArticleCard } from "../../components/ArticleCard";
import { AskStoryCard, type AskStoryFns } from "../../components/AskStoryCard";
import { AudienceExplainCard } from "../../components/artifacts/AudienceExplainCard";
import { ClassroomDiscussionCard } from "../../components/artifacts/ClassroomDiscussionCard";
import { EducationEvidenceCard } from "../../components/artifacts/EducationEvidenceCard";
import { FinanceConceptCard } from "../../components/artifacts/FinanceConceptCard";
import { FinanceRealityCheckCard } from "../../components/artifacts/FinanceRealityCheckCard";
import { LearningMaterialCard } from "../../components/artifacts/LearningMaterialCard";
import { PaperDecoderCard } from "../../components/artifacts/PaperDecoderCard";
import { PolicyImpactCard } from "../../components/artifacts/PolicyImpactCard";
import { RegulationWatchCard } from "../../components/artifacts/RegulationWatchCard";
import { SkillsCareerTrendsCard } from "../../components/artifacts/SkillsCareerTrendsCard";
import { StoryBriefCard } from "../../components/artifacts/StoryBriefCard";
import { IndustryImpactCard } from "../../components/artifacts/IndustryImpactCard";
import { SupplyChainRippleCard } from "../../components/artifacts/SupplyChainRippleCard";
import { EarningsDecoderCard } from "../../components/artifacts/EarningsDecoderCard";
import { LaunchRealityCheckCard } from "../../components/artifacts/LaunchRealityCheckCard";
import { EvolutionTimelineCard } from "../../components/artifacts/EvolutionTimelineCard";
import { Disclaimer } from "../../components/Disclaimer";
import { InspectEvidencePanel } from "../../components/evidence/InspectEvidencePanel";
import {
  getEvent,
  getEventArtifactSources,
  getEventSources,
} from "../../server/publication/api";
import type {
  ArtifactSourceView,
  EventSourceView,
  EventView,
} from "../../server/publication/events";
import { askAboutStory, getStoryAnswer } from "../../server/reader-ask/api";
import { ARTIFACT_AUDIENCES } from "../../lib/artifacts/types";
import { FINANCE_SLUG } from "../../lib/sections";
import { SITE_NAME } from "../../lib/site";

const rootRoute = getRouteApi("__root__");

const ASK_FNS: AskStoryFns = {
  onAsk: (input) => askAboutStory({ data: input }),
  onPoll: (input) => getStoryAnswer({ data: input }),
};

export async function loadEvent(
  params: { eventId: string },
  fns = {
    getEvent: (eventId: number) => getEvent({ data: { eventId } }),
    getEventSources: (eventId: number) =>
      getEventSources({ data: { eventId } }),
    getEventArtifactSources: (eventId: number) =>
      getEventArtifactSources({ data: { eventId } }),
  },
) {
  const eventId = Number(params.eventId);
  if (Number.isNaN(eventId) || eventId <= 0) throw notFound();
  // Awaited, not streamed: the artifact cards are in the shell and show them.
  const [data, artifactSources] = await Promise.all([
    fns.getEvent(eventId),
    // Source info is optional: a failed query must not break the page or
    // turn a 404 into a 500.
    fns.getEventArtifactSources(eventId).catch((e) => {
      console.error({ error: "artifact sources query failed", eventId, e });
      return [];
    }),
  ]);
  if (!data) throw notFound();
  return {
    data,
    artifactSources,
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
          ? `${loaderData.data.title} — ${SITE_NAME}`
          : SITE_NAME,
      },
    ],
  }),
  notFoundComponent: () => <p className="pt-6 text-sm">No such event.</p>,
  component: EventPage,
});

function EventPage() {
  const { data, artifactSources, sources } = Route.useLoaderData();
  // The switch comes from the root loader (loadSiteShell), so the card is in
  // the server HTML or absent: no flash.
  const { askPublicEnabled } = rootRoute.useLoaderData();
  return (
    <EventPageView
      data={data}
      artifactSources={artifactSources}
      sources={sources}
      ask={askPublicEnabled ? ASK_FNS : null}
    />
  );
}

interface PagePart {
  id: string;
  label: string;
  show: boolean;
  render: () => ReactNode;
}

// The story timeline always renders, after the sources line.
const TIMELINE_PART = { id: "timeline", label: "Timeline", show: true };

export function EventPageView({
  data,
  artifactSources,
  sources,
  ask = null,
}: {
  data: EventView;
  artifactSources: ArtifactSourceView[];
  sources: Promise<EventSourceView[]>;
  /** Set only while ASK_PUBLIC_ENABLED is "true". */
  ask?: AskStoryFns | null;
}) {
  const {
    section,
    articles,
    corrections,
    title,
    artifacts,
    evidence,
    timelineRevisions,
  } = data;

  const verifiedClaims = evidence?.claims
    ?.filter((c) => c.consensusStatus === "verified")
    .map((c) => c.claimText);

  // Cards that render nothing without artifact sources or a usable tier.
  // `show` mirrors each card's own empty check, so the anchor nav never
  // links to a section that is not on the page.
  const hasSources = artifactSources.length > 0;
  const hasTier = (byTier: Partial<Record<string, unknown>> | undefined) =>
    ARTIFACT_AUDIENCES.some((tier) => !!byTier?.[tier]);

  // In page order. Each part sits in its own anchor target.
  const parts: PagePart[] = [
    {
      id: "brief",
      label: "Brief",
      show: !!artifacts?.brief && hasSources,
      render: () =>
        artifacts?.brief && (
          <StoryBriefCard
            brief={artifacts.brief}
            verifiedClaims={verifiedClaims}
            sources={artifactSources}
          />
        ),
    },
    {
      id: "ask",
      label: "Ask",
      // v1 has no Ask for Finance (#133).
      show: !!ask && section.slug !== FINANCE_SLUG,
      render: () => ask && <AskStoryCard eventId={data.id} {...ask} />,
    },
    {
      id: "evidence",
      label: "Evidence",
      show: !!evidence && evidence.claims.length > 0,
      render: () => evidence && <InspectEvidencePanel evidence={evidence} />,
    },
    {
      id: "explain",
      label: "Explain",
      show: hasTier(artifacts?.explanations) && hasSources,
      render: () =>
        artifacts && (
          <AudienceExplainCard
            explanations={artifacts.explanations}
            sources={artifactSources}
          />
        ),
    },
    {
      id: "paper-decoder",
      label: "Paper decoder",
      show: !!artifacts?.decoder,
      render: () =>
        artifacts?.decoder && <PaperDecoderCard decoder={artifacts.decoder} />,
    },
    {
      id: "launch-check",
      label: "Launch check",
      show: !!artifacts?.launchRealityCheck && hasSources,
      render: () =>
        artifacts?.launchRealityCheck && (
          <LaunchRealityCheckCard
            check={artifacts.launchRealityCheck}
            sources={artifactSources}
          />
        ),
    },
    {
      id: "evolution",
      label: "Evolution timeline",
      show: !!artifacts?.evolutionTimeline && hasSources,
      render: () =>
        artifacts?.evolutionTimeline && (
          <EvolutionTimelineCard
            timeline={artifacts.evolutionTimeline}
            sources={artifactSources}
          />
        ),
    },
    {
      id: "learn",
      label: "Learn",
      show: hasTier(artifacts?.learningMaterials) && hasSources,
      render: () =>
        artifacts?.learningMaterials && (
          <LearningMaterialCard
            materials={artifacts.learningMaterials}
            sources={artifactSources}
          />
        ),
    },
    {
      id: "policy-impact",
      label: "Policy impact",
      show: !!artifacts?.policyImpact,
      render: () =>
        artifacts?.policyImpact && (
          <PolicyImpactCard policy={artifacts.policyImpact} />
        ),
    },
    {
      id: "classroom",
      label: "Classroom discussion",
      show: !!artifacts?.classroomDiscussion,
      render: () =>
        artifacts?.classroomDiscussion && (
          <ClassroomDiscussionCard guide={artifacts.classroomDiscussion} />
        ),
    },
    {
      id: "education-evidence",
      label: "Education evidence",
      show: !!artifacts?.educationEvidence,
      render: () =>
        artifacts?.educationEvidence && (
          <EducationEvidenceCard evidence={artifacts.educationEvidence} />
        ),
    },
    {
      id: "finance-check",
      label: "Finance reality check",
      show: !!artifacts?.financeRealityCheck,
      render: () =>
        artifacts?.financeRealityCheck && (
          <FinanceRealityCheckCard check={artifacts.financeRealityCheck} />
        ),
    },
    {
      id: "regulation-watch",
      label: "Regulation watch",
      show: !!artifacts?.regulationWatch,
      render: () =>
        artifacts?.regulationWatch && (
          <RegulationWatchCard watch={artifacts.regulationWatch} />
        ),
    },
    {
      id: "finance-concept",
      label: "Finance concepts",
      show: !!artifacts?.financeConcept,
      render: () =>
        artifacts?.financeConcept && (
          <FinanceConceptCard concept={artifacts.financeConcept} />
        ),
    },
    {
      id: "skills",
      label: "Skills and careers",
      show: !!artifacts?.skillsCareerTrends,
      render: () =>
        artifacts?.skillsCareerTrends && (
          <SkillsCareerTrendsCard trends={artifacts.skillsCareerTrends} />
        ),
    },
    {
      id: "industry-impact",
      label: "Industry impact",
      show: !!artifacts?.industryImpact,
      render: () =>
        artifacts?.industryImpact && (
          <IndustryImpactCard report={artifacts.industryImpact} />
        ),
    },
    {
      id: "supply-chain",
      label: "Supply chain",
      show: !!artifacts?.supplyChainRipple,
      render: () =>
        artifacts?.supplyChainRipple && (
          <SupplyChainRippleCard ripple={artifacts.supplyChainRipple} />
        ),
    },
    {
      id: "earnings",
      label: "Earnings decoder",
      show: !!artifacts?.earningsDecoder,
      render: () =>
        artifacts?.earningsDecoder && (
          <EarningsDecoderCard decoder={artifacts.earningsDecoder} />
        ),
    },
  ];

  return (
    <div data-section={section.slug} className="flex flex-col gap-4 pt-4">
      <nav aria-label="Breadcrumb">
        <Link
          to="/s/$section"
          params={{ section: section.slug }}
          className="text-xs font-bold text-foreground hover:underline"
        >
          ← {section.name}
        </Link>
      </nav>

      <header className="border-t-[3px] border-foreground pt-2">
        <h1 className="font-heading text-2xl font-semibold leading-tight sm:text-3xl tracking-tight">
          {title}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {articles.length} {articles.length === 1 ? "report" : "reports"} on
          this story
        </p>
      </header>

      <nav
        aria-label="On this page"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-background py-2 text-sm sm:sticky sm:top-0 sm:z-10"
      >
        <span className="text-muted-foreground">On this page</span>
        {[...parts, TIMELINE_PART]
          .filter((part) => part.show)
          .map((part) => (
            <a
              key={part.id}
              href={`#${part.id}`}
              className="text-foreground underline"
            >
              {part.label}
            </a>
          ))}
      </nav>

      {section.disclaimer && <Disclaimer text={section.disclaimer} />}

      {parts
        .filter((part) => part.show)
        .map((part) => (
          <div key={part.id} id={part.id} className="min-w-0 scroll-mt-14">
            {part.render()}
          </div>
        ))}

      {corrections.length > 0 && (
        <div className="border border-destructive p-3">
          <h2 className="text-xs font-bold text-destructive">Correction</h2>
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
              <aside className="border-y py-2 text-[0.72rem] leading-relaxed">
                <span className="mr-2 font-bold text-muted-foreground">
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

      <section
        id={TIMELINE_PART.id}
        aria-label="Story timeline"
        className="flex scroll-mt-14 flex-col gap-4 border-t border-border pt-6"
      >
        <h2 className="text-xs font-bold text-muted-foreground">Timeline</h2>
        <div className="flex flex-col gap-5">
          {timelineRevisions && timelineRevisions.length > 0
            ? timelineRevisions.map((revBlock, revIdx) => (
                <div
                  key={revBlock.revision}
                  className="flex flex-col gap-3 border border-border/70 bg-card/30 p-3 sm:p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
                        Revision {revBlock.revision}
                      </span>
                      {revIdx === 0 && (
                        <span className="flex items-center gap-1 text-[0.68rem] font-bold text-muted-foreground">
                          ★ First seen
                        </span>
                      )}
                    </div>
                  </div>

                  {revBlock.diff && revBlock.diff.summary && (
                    <div className="flex flex-col gap-1.5 bg-muted/40 p-2.5 font-sans text-xs leading-relaxed text-foreground/90">
                      <div>
                        <span className="font-bold text-muted-foreground mr-1">
                          ★ What&apos;s new in this revision:
                        </span>
                        <span>{revBlock.diff.summary}</span>
                      </div>
                      {revBlock.diff.changedClaims &&
                        revBlock.diff.changedClaims.length > 0 && (
                          <div className="mt-1 flex flex-col gap-1 border-t border-border/30 pt-1.5">
                            <span className="text-[0.7rem] font-semibold text-muted-foreground">
                              Status updates on existing claims:
                            </span>
                            <ul className="list-inside list-disc space-y-0.5 text-[0.75rem] text-foreground/80">
                              {revBlock.diff.changedClaims.map(
                                (claim, cIdx) => (
                                  <li key={cIdx}>{claim}</li>
                                ),
                              )}
                            </ul>
                          </div>
                        )}
                    </div>
                  )}

                  <div className="flex flex-col gap-3">
                    {revBlock.articles.map((a) => (
                      <div key={a.id} className="flex flex-col gap-1">
                        {a.evidence &&
                          (a.evidence.includes("preprint") ||
                            a.evidence.includes("primary_source")) && (
                            <div className="flex items-center gap-1.5 text-[0.68rem] font-bold text-muted-foreground">
                              <span>★ Original source</span>
                            </div>
                          )}
                        <ArticleCard article={a} />
                      </div>
                    ))}
                  </div>
                </div>
              ))
            : articles.map((a, idx) => (
                <div key={a.id} className="flex flex-col gap-1">
                  {idx === 0 && (
                    <div className="flex items-center gap-1.5 text-[0.68rem] font-bold text-muted-foreground">
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
