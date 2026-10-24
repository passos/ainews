import { sql } from "drizzle-orm";
import type {
  ClaimEvidenceView,
  ClaimType,
  ClaimView,
  ConsensusStatus,
  EventEvidenceView,
  EvidencePublicationStatus,
  EvidenceStance,
} from "../../lib/evidence/types";
import { approvedArticleWhere, type Db } from "./articles";

export async function getEventEvidence(
  db: Db,
  eventId: number,
): Promise<EventEvidenceView> {
  // 1. Fetch published claims for current event revision
  const claimRows = await db.all<{
    id: number;
    claim_text: string;
    claim_type: string;
    consensus_status: string;
    primary_source_preferred: number;
    status: string;
  }>(sql`
    SELECT
      c.id,
      c.claim_text,
      c.claim_type,
      c.consensus_status,
      c.primary_source_preferred,
      c.status
    FROM claims c
    JOIN events e ON e.id = c.event_id
    WHERE c.event_id = ${eventId}
      AND c.status = 'published'
      AND c.input_revision = e.revision
      AND c.claim_text NOT LIKE '[%]'
    ORDER BY c.id ASC
  `);

  if (!claimRows || claimRows.length === 0) {
    return { eventId, claims: [] };
  }

  const claimIds = claimRows.map((r) => r.id);

  // 2. Fetch verified citations matching approved article current body
  const evidenceRows = await db.all<{
    id: number;
    claim_id: number;
    article_id: number;
    article_title: string;
    article_url: string;
    source_name: string;
    source_domain: string;
    body_sha: string;
    quote: string;
    start_offset: number;
    end_offset: number;
    stance: string;
    is_primary_source: number;
    verified: number;
  }>(sql`
    SELECT
      ce.id,
      ce.claim_id,
      ce.article_id,
      COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title) AS article_title,
      a.canonical_url AS article_url,
      COALESCE(NULLIF(s.name, ''), s.site_domain, 'Unknown source') AS source_name,
      s.site_domain AS source_domain,
      ce.body_sha,
      ce.quote,
      ce.start_offset,
      ce.end_offset,
      ce.stance,
      ce.is_primary_source,
      ce.verified
    FROM claim_evidence ce
    JOIN claims c ON c.id = ce.claim_id
    JOIN articles a ON a.id = ce.article_id
    JOIN sources s ON s.id = a.source_id
    JOIN event_articles ea ON ea.article_id = a.id AND ea.event_id = ${eventId}
    LEFT JOIN analyses an ON an.id = (
      SELECT id FROM analyses
      WHERE article_id = a.id AND selected = 1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
    WHERE ${approvedArticleWhere}
      AND c.event_id = ${eventId}
      AND c.status = 'published'
      AND c.input_revision = (SELECT revision FROM events WHERE id = ${eventId})
      AND ce.body_sha = a.body_sha
      AND ce.verified = 1
    ORDER BY ce.is_primary_source DESC, ce.id ASC
  `);

  const claimIdSet = new Set(claimIds);
  const evidenceByClaimId = new Map<number, ClaimEvidenceView[]>();
  for (const row of evidenceRows) {
    if (!claimIdSet.has(row.claim_id)) continue;
    const list = evidenceByClaimId.get(row.claim_id) ?? [];
    list.push({
      id: row.id,
      articleId: row.article_id,
      articleTitle: row.article_title,
      articleUrl: row.article_url,
      sourceName: row.source_name,
      sourceDomain: row.source_domain,
      bodySha: row.body_sha,
      quote: row.quote,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      stance: row.stance as EvidenceStance,
      isPrimarySource: row.is_primary_source === 1,
      verified: row.verified === 1,
    });
    evidenceByClaimId.set(row.claim_id, list);
  }

  const claims: ClaimView[] = claimRows.map((r) => ({
    id: r.id,
    claimText: r.claim_text,
    claimType: r.claim_type as ClaimType,
    consensusStatus: r.consensus_status as ConsensusStatus,
    primarySourcePreferred: r.primary_source_preferred === 1,
    status: r.status as EvidencePublicationStatus,
    evidence: evidenceByClaimId.get(r.id) ?? [],
  }));

  return { eventId, claims };
}
