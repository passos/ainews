// Which sections a story page shows (#87 A3a). One definition, used by the
// /e/$id nav and by the sidebar of /a/$id, so the two never disagree.
import { ARTIFACT_AUDIENCES } from "../../lib/artifacts/types";
import { FINANCE_SLUG } from "../../lib/sections";
import { getArticlePage, type ArticlePage, type Db } from "./articles";
import { getEvent, getEventArtifactSources, type EventView } from "./events";

export interface EventSectionFlags {
  brief: boolean;
  /** The claim count the Evidence section shows; 0 = no such section. */
  evidenceClaims: number;
  explain: boolean;
  ask: boolean;
}

export const hasTier = (byTier: Partial<Record<string, unknown>> | undefined) =>
  ARTIFACT_AUDIENCES.some((tier) => !!byTier?.[tier]);

/**
 * @param hasSources the story has artifact sources (cards that cite sources
 *   render nothing without them)
 * @param askEnabled ASK_PUBLIC_ENABLED is on
 */
export function eventSectionFlags(
  data: EventView,
  hasSources: boolean,
  askEnabled: boolean,
): EventSectionFlags {
  return {
    brief: !!data.artifacts?.brief && hasSources,
    evidenceClaims: data.evidence?.claims.length ?? 0,
    explain: hasTier(data.artifacts?.explanations) && hasSources,
    // v1 has no Ask for Finance (#133).
    ask: askEnabled && data.section.slug !== FINANCE_SLUG,
  };
}

/**
 * The reader page of one approved article, with the story data its sidebar
 * needs. The story is read through getEvent, so only approved articles and
 * published artifacts of the current revision count.
 */
export async function getArticlePageWithEvent(
  db: Db,
  bodies: Pick<R2Bucket, "get">,
  id: number,
  opts: { askEnabled: boolean },
): Promise<ArticlePage | null> {
  const page = await getArticlePage(db, bodies, id);
  if (!page || page.article.eventId === null) return page;
  const eventId = page.article.eventId;
  const [data, sources] = await Promise.all([
    getEvent(db, eventId),
    getEventArtifactSources(db, eventId),
  ]);
  if (!data) return page;
  const sections = eventSectionFlags(data, sources.length > 0, opts.askEnabled);
  return {
    ...page,
    event: {
      whatHappened: sections.brief
        ? (data.artifacts?.brief?.whatHappened ?? null)
        : null,
      sections,
    },
  };
}
