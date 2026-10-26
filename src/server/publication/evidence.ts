import { sql } from "drizzle-orm";
import type {
  ClaimType,
  ClaimView,
  ConsensusStatus,
  EventEvidenceView,
  EvidencePublicationStatus,
  EvidenceStance,
  RealityCheckStatus,
  SourceRole,
} from "../../lib/evidence/types";
import {
  approvedArticleWhere,
  SOURCE_DOMAIN,
  SOURCE_NAME,
  type Db,
} from "./articles";

export async function getEventEvidence(
  db: Db,
  eventId: number,
): Promise<EventEvidenceView> {
  const rows = await db.all<{
    claim_id: number;
    claim_text: string;
    claim_type: string;
    consensus_status: string;
    primary_source_preferred: number;
    reality_check: string;
    claim_status: string;
    evidence_id: number | null;
    article_id: number | null;
    article_title: string | null;
    article_url: string | null;
    source_name: string | null;
    source_domain: string | null;
    body_sha: string | null;
    quote: string | null;
    start_offset: number | null;
    end_offset: number | null;
    stance: string | null;
    is_primary_source: number | null;
    source_role: string | null;
    verified: number | null;
  }>(sql`
    SELECT
      c.id AS claim_id,
      c.claim_text,
      c.claim_type,
      c.consensus_status,
      c.primary_source_preferred,
      COALESCE(c.reality_check, 'unspecified') AS reality_check,
      c.status AS claim_status,
      ev.id AS evidence_id,
      ev.article_id,
      ev.article_title,
      ev.article_url,
      ev.source_name,
      ev.source_domain,
      ev.body_sha,
      ev.quote,
      ev.start_offset,
      ev.end_offset,
      ev.stance,
      ev.is_primary_source,
      ev.source_role,
      ev.verified
    FROM events e
    JOIN claims c ON c.event_id = e.id AND c.input_revision = e.revision
    LEFT JOIN (
      SELECT
        ce.id,
        ce.claim_id,
        ce.article_id,
        ce.body_sha,
        ce.quote,
        ce.start_offset,
        ce.end_offset,
        ce.stance,
        ce.is_primary_source,
        COALESCE(ce.source_role, 'independent') AS source_role,
        ce.verified,
        COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title) AS article_title,
        a.canonical_url AS article_url,
        ${SOURCE_NAME} AS source_name,
        ${SOURCE_DOMAIN} AS source_domain
      FROM claim_evidence ce
      JOIN articles a ON a.id = ce.article_id AND ce.body_sha = a.body_sha AND ${approvedArticleWhere}
      JOIN sources s ON s.id = a.source_id
      JOIN event_articles ea ON ea.article_id = a.id AND ea.event_id = ${eventId}
      LEFT JOIN analyses an ON an.id = (
        SELECT id FROM analyses
        WHERE article_id = a.id AND selected = 1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      WHERE ce.verified = 1
    ) ev ON ev.claim_id = c.id
    WHERE e.id = ${eventId}
      AND c.status = 'published'
      AND c.claim_text NOT LIKE '[%]'
    ORDER BY c.id ASC, ev.is_primary_source DESC, ev.id ASC
  `);

  if (!rows || rows.length === 0) {
    return { eventId, claims: [] };
  }

  const claimMap = new Map<number, ClaimView>();
  for (const r of rows) {
    let claim = claimMap.get(r.claim_id);
    if (!claim) {
      claim = {
        id: r.claim_id,
        claimText: r.claim_text,
        claimType: r.claim_type as ClaimType,
        consensusStatus: r.consensus_status as ConsensusStatus,
        primarySourcePreferred: r.primary_source_preferred === 1,
        realityCheck: (r.reality_check as RealityCheckStatus) || "unspecified",
        status: r.claim_status as EvidencePublicationStatus,
        evidence: [],
      };
      claimMap.set(r.claim_id, claim);
    }
    if (
      r.evidence_id != null &&
      r.article_id != null &&
      r.article_url != null
    ) {
      claim.evidence.push({
        id: r.evidence_id,
        articleId: r.article_id,
        articleTitle: r.article_title ?? "",
        articleUrl: r.article_url,
        sourceName: r.source_name ?? "",
        sourceDomain: r.source_domain ?? "",
        bodySha: r.body_sha ?? "",
        quote: r.quote ?? "",
        startOffset: r.start_offset ?? 0,
        endOffset: r.end_offset ?? 0,
        stance: (r.stance ?? "support") as EvidenceStance,
        isPrimarySource: r.is_primary_source === 1,
        sourceRole: (r.source_role as SourceRole) || "independent",
        verified: r.verified === 1,
      });
    }
  }

  return { eventId, claims: Array.from(claimMap.values()) };
}
