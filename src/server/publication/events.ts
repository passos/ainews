import { sql } from "drizzle-orm";
import {
  type ArtifactAudience,
  type EventArtifactsView,
  type RevisionDiff,
  audienceExplainSchema,
  classroomDiscussionBuilderSchema,
  educationEvidenceCheckerSchema,
  earningsDecoderSchema,
  financeConceptExplainerSchema,
  financeRealityCheckSchema,
  industryImpactReportSchema,
  learningMaterialSchema,
  policyImpactExplorerSchema,
  regulationWatchSchema,
  researchPaperDecoderSchema,
  revisionDiffSchema,
  skillsCareerTrendsSchema,
  storyBriefSchema,
  supplyChainRippleMapSchema,
} from "../../lib/artifacts/types";
import type { EventEvidenceView } from "../../lib/evidence/types";
import {
  approvedArticleWhere,
  CARD_COLUMNS,
  CARD_FROM,
  SOURCE_NAME,
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
    learningMaterials: {},
    policyImpact: null,
    classroomDiscussion: null,
    educationEvidence: null,
    financeRealityCheck: null,
    regulationWatch: null,
    financeConcept: null,
    skillsCareerTrends: null,
    industryImpact: null,
    supplyChainRipple: null,
    earningsDecoder: null,
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
      } else if (row.type === "learning_material") {
        const res = learningMaterialSchema.safeParse(parsedJson);
        if (res.success) {
          const aud = (row.audience || res.data.audience) as ArtifactAudience;
          if (!artifacts.learningMaterials) artifacts.learningMaterials = {};
          artifacts.learningMaterials[aud] = res.data;
        }
      } else if (row.type === "policy_impact_explorer") {
        const res = policyImpactExplorerSchema.safeParse(parsedJson);
        if (res.success) artifacts.policyImpact = res.data;
      } else if (row.type === "classroom_discussion_builder") {
        const res = classroomDiscussionBuilderSchema.safeParse(parsedJson);
        if (res.success) artifacts.classroomDiscussion = res.data;
      } else if (row.type === "education_evidence_checker") {
        const res = educationEvidenceCheckerSchema.safeParse(parsedJson);
        if (res.success) artifacts.educationEvidence = res.data;
      } else if (row.type === "finance_reality_check") {
        const res = financeRealityCheckSchema.safeParse(parsedJson);
        if (res.success) artifacts.financeRealityCheck = res.data;
      } else if (row.type === "regulation_watch") {
        const res = regulationWatchSchema.safeParse(parsedJson);
        if (res.success) artifacts.regulationWatch = res.data;
      } else if (row.type === "finance_concept_explainer") {
        const res = financeConceptExplainerSchema.safeParse(parsedJson);
        if (res.success) artifacts.financeConcept = res.data;
      } else if (row.type === "skills_career_trends") {
        const res = skillsCareerTrendsSchema.safeParse(parsedJson);
        if (res.success) artifacts.skillsCareerTrends = res.data;
      } else if (row.type === "industry_impact_report") {
        const res = industryImpactReportSchema.safeParse(parsedJson);
        if (res.success) artifacts.industryImpact = res.data;
      } else if (row.type === "supply_chain_ripple_map") {
        const res = supplyChainRippleMapSchema.safeParse(parsedJson);
        if (res.success) artifacts.supplyChainRipple = res.data;
      } else if (row.type === "earnings_decoder") {
        const res = earningsDecoderSchema.safeParse(parsedJson);
        if (res.success) artifacts.earningsDecoder = res.data;
      }
    } catch {
      // ignore invalid json in publication layer
    }
  }

  const evidence = await getEventEvidence(db, eventId);

  // Find claims whose evidence has been completely withdrawn or rejected (publication guard)
  const withdrawnClaimRows = await db.all<{ claim_text: string }>(sql`
    SELECT DISTINCT c.claim_text
    FROM claims c
    WHERE c.event_id = ${eventId}
      AND EXISTS (
        SELECT 1 FROM claim_evidence ce
        WHERE ce.claim_id = c.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM claim_evidence ce
        JOIN articles a ON a.id = ce.article_id AND ce.body_sha = a.body_sha AND ${approvedArticleWhere}
        JOIN event_articles ea ON ea.article_id = a.id AND ea.event_id = ${eventId}
        WHERE ce.claim_id = c.id AND ce.verified = 1
      )
  `);
  const withdrawnClaimsSet = new Set(
    withdrawnClaimRows.map((r) => r.claim_text),
  );

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
      AND (
        EXISTS (
          SELECT 1 FROM event_articles ea2
          JOIN articles a ON a.id = ea2.article_id
          WHERE ea2.event_id = ea.event_id
            AND ea2.input_revision = ea.input_revision
            AND ${approvedArticleWhere}
        )
        OR NOT EXISTS (
          SELECT 1 FROM event_articles ea3
          WHERE ea3.event_id = ea.event_id
            AND ea3.input_revision = ea.input_revision
        )
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

  function sanitizeRevisionDiff(diff: RevisionDiff, rev: number): RevisionDiff {
    const extractBaseClaim = (c: string): string => {
      const lastParen = c.lastIndexOf(" (");
      return lastParen !== -1 && c.endsWith(")") ? c.slice(0, lastParen) : c;
    };

    const hasWithdrawn =
      diff.newClaims.some((c) => withdrawnClaimsSet.has(c)) ||
      diff.changedClaims.some((c) =>
        withdrawnClaimsSet.has(extractBaseClaim(c)),
      );

    if (!hasWithdrawn) {
      return diff;
    }

    const newClaims = diff.newClaims.filter((c) => !withdrawnClaimsSet.has(c));
    const changedClaims = diff.changedClaims.filter(
      (c) => !withdrawnClaimsSet.has(extractBaseClaim(c)),
    );

    let summary: string;
    if (rev <= 1) {
      summary =
        diff.newSources.length > 0
          ? `Initial report based on ${diff.newSources.join(", ")}.`
          : "Initial reporting on the event.";
    } else if (newClaims.length > 0 && diff.newSources.length > 0) {
      summary = `New claims identified from ${diff.newSources.join(", ")}: ${newClaims.slice(0, 2).join("; ")}.`;
    } else if (diff.newSources.length > 0) {
      summary = `New sources added: ${diff.newSources.join(", ")}.`;
    } else if (newClaims.length > 0) {
      summary = `New claims identified: ${newClaims.slice(0, 2).join("; ")}.`;
    } else if (changedClaims.length > 0) {
      summary = `Updated reality check status on existing claims.`;
    } else {
      summary = `Event updated at revision ${rev}.`;
    }

    return {
      revision: rev,
      summary,
      newSources: diff.newSources,
      newClaims,
      changedClaims,
    };
  }

  const revisionSet = new Set<number>();
  for (const a of articles) {
    revisionSet.add(a.inputRevision);
  }
  for (const d of diffRows) {
    revisionSet.add(d.input_revision);
  }
  if (revisionSet.size === 0) revisionSet.add(1);

  const sortedRevisions = Array.from(revisionSet).sort((a, b) => a - b);
  const timelineRevisions: RevisionTimelineBlock[] = sortedRevisions.map(
    (rev) => {
      const rawDiff = diffMap.get(rev);
      return {
        revision: rev,
        diff: rawDiff ? sanitizeRevisionDiff(rawDiff, rev) : null,
        articles: articles.filter((a) => a.inputRevision === rev),
      };
    },
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
      ${SOURCE_NAME} AS name,
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
