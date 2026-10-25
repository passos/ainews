import { sql } from "drizzle-orm";
import {
  type ArtifactAudience,
  type EventArtifactsView,
  type RevisionDiff,
  audienceExplainSchema,
  researchPaperDecoderSchema,
  revisionDiffSchema,
  storyBriefSchema,
} from "../../lib/artifacts/types";
import type { EventEvidenceView } from "../../lib/evidence/types";
import {
  approvedArticleWhere,
  CARD_COLUMNS,
  CARD_FROM,
  toViews,
  type ArticleView,
  type CardRow,
  type Db,
  type SectionInfo,
} from "./articles";
import { getEventEvidence } from "./evidence";

export interface RevisionTimelineBlock {
  revision: number;
  diff: RevisionDiff | null;
  articles: ArticleView[];
}

export interface EventView {
  id: number;
  title: string;
  section: SectionInfo;
  articles: ArticleView[];
  timelineRevisions: RevisionTimelineBlock[];
  corrections: string[];
  artifacts: EventArtifactsView;
  evidence: EventEvidenceView;
}

export interface EventSourceView {
  name: string;
  count: number;
}

export async function getEvent(
  db: Db,
  eventId: number,
): Promise<EventView | null> {
  // Query approved articles in timeline order (earliest first)
  const rows = await db.all<CardRow>(sql`
    SELECT
      ${CARD_COLUMNS}
      ${CARD_FROM}
    WHERE ea.event_id = ${eventId} AND ${approvedArticleWhere}
    ORDER BY COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC
  `);

  const articles = toViews(rows);
  if (articles.length === 0) return null;

  const first = articles[0];
  const section: SectionInfo = {
    slug: first.sectionSlug,
    name: first.sectionName,
    disclaimer: first.sectionDisclaimer,
  };

  const correctionRows = await db.all<{ body: string }>(sql`
    SELECT body FROM corrections
    WHERE target_type = 'events' AND target_id = ${eventId}
    ORDER BY created_at DESC, id DESC
  `);

  const artifactRows = await db.all<{
    type: string;
    audience: string;
    content: string;
  }>(sql`
    SELECT ea.type, ea.audience, ea.content
    FROM event_artifacts ea
    JOIN events e ON e.id = ea.event_id
    WHERE ea.event_id = ${eventId}
      AND ea.status = 'published'
      AND ea.input_revision = e.revision
    ORDER BY ea.created_at ASC, ea.id ASC
  `);

  const artifacts: EventArtifactsView = {
    brief: null,
    explanations: {},
    decoder: null,
  };

  for (const row of artifactRows) {
    try {
      const parsedJson = JSON.parse(row.content);
      if (row.type === "story_brief") {
        const res = storyBriefSchema.safeParse(parsedJson);
        if (res.success) artifacts.brief = res.data;
      } else if (row.type === "audience_explain") {
        const res = audienceExplainSchema.safeParse(parsedJson);
        if (res.success) {
          const aud = (row.audience || res.data.audience) as ArtifactAudience;
          artifacts.explanations[aud] = res.data;
        }
      } else if (row.type === "research_paper_decoder") {
        const res = researchPaperDecoderSchema.safeParse(parsedJson);
        if (res.success) artifacts.decoder = res.data;
      }
    } catch {
      // ignore invalid json in publication layer
    }
  }

  const evidence = await getEventEvidence(db, eventId);

  // Load all published revision_diff artifacts for this event (N§2.2)
  // Architecture §7 publication guard: only load diffs for revisions that currently have approved articles
  const diffRows = await db.all<{
    input_revision: number;
    content: string;
  }>(sql`
    SELECT ea.input_revision, ea.content
    FROM event_artifacts ea
    WHERE ea.event_id = ${eventId}
      AND ea.type = 'revision_diff'
      AND ea.status = 'published'
      AND EXISTS (
        SELECT 1 FROM event_articles ea2
        JOIN articles a ON a.id = ea2.article_id
        WHERE ea2.event_id = ea.event_id
          AND ea2.input_revision = ea.input_revision
          AND ${approvedArticleWhere}
      )
    ORDER BY ea.input_revision ASC
  `);

  const diffMap = new Map<number, RevisionDiff>();
  for (const d of diffRows) {
    try {
      const parsed = revisionDiffSchema.safeParse(JSON.parse(d.content));
      if (parsed.success) {
        diffMap.set(d.input_revision, parsed.data);
      }
    } catch {
      // ignore json error
    }
  }

  const revisionSet = new Set<number>();
  for (const a of articles) {
    revisionSet.add(a.inputRevision);
  }
  if (revisionSet.size === 0) revisionSet.add(1);

  const sortedRevisions = Array.from(revisionSet).sort((a, b) => a - b);
  const timelineRevisions: RevisionTimelineBlock[] = sortedRevisions.map(
    (rev) => ({
      revision: rev,
      diff: diffMap.get(rev) ?? null,
      articles: articles.filter((a) => a.inputRevision === rev),
    }),
  );

  return {
    id: eventId,
    // Event public title: title of earliest approved article (refinement invariant 7)
    title: first.title,
    section,
    articles,
    timelineRevisions,
    corrections: correctionRows.map((c) => c.body),
    artifacts,
    evidence,
  };
}

export async function getEventSources(
  db: Db,
  eventId: number,
): Promise<EventSourceView[]> {
  const rows = await db.all<{ name: string; count: number }>(sql`
    SELECT
      COALESCE(NULLIF(s.name, ''), s.site_domain, 'Unknown source') AS name,
      count(*) AS count
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    JOIN event_articles ea ON ea.article_id = a.id
    WHERE ea.event_id = ${eventId} AND ${approvedArticleWhere}
    GROUP BY name
    ORDER BY count DESC, name ASC
  `);

  return rows.map((r) => ({
    name: r.name,
    count: Number(r.count),
  }));
}
