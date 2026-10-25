import { z } from "zod";

export const CLAIM_TYPES = ["fact", "interpretation", "prediction"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const CONSENSUS_STATUSES = [
  "verified",
  "disputed",
  "unverified",
] as const;
export type ConsensusStatus = (typeof CONSENSUS_STATUSES)[number];

export const EVIDENCE_STANCES = ["support", "dispute"] as const;
export type EvidenceStance = (typeof EVIDENCE_STANCES)[number];

export const EVIDENCE_PUBLICATION_STATUSES = [
  "published",
  "pending_review",
  "rejected",
] as const;
export type EvidencePublicationStatus =
  (typeof EVIDENCE_PUBLICATION_STATUSES)[number];

export const claimTypeSchema = z.enum(CLAIM_TYPES);
export const consensusStatusSchema = z.enum(CONSENSUS_STATUSES);
export const evidenceStanceSchema = z.enum(EVIDENCE_STANCES);
export const evidencePublicationStatusSchema = z.enum(
  EVIDENCE_PUBLICATION_STATUSES,
);

export const claimEvidenceViewSchema = z.strictObject({
  id: z.number().int().positive(),
  articleId: z.number().int().positive(),
  articleTitle: z.string().min(1),
  articleUrl: z.string().url(),
  sourceName: z.string().min(1),
  sourceDomain: z.string().min(1),
  bodySha: z.string().min(1),
  quote: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  stance: evidenceStanceSchema,
  isPrimarySource: z.boolean(),
  verified: z.boolean(),
});

export type ClaimEvidenceView = z.infer<typeof claimEvidenceViewSchema>;

export const claimViewSchema = z.strictObject({
  id: z.number().int().positive(),
  claimText: z.string().min(1),
  claimType: claimTypeSchema,
  consensusStatus: consensusStatusSchema,
  primarySourcePreferred: z.boolean(),
  status: evidencePublicationStatusSchema,
  evidence: z.array(claimEvidenceViewSchema),
});

export type ClaimView = z.infer<typeof claimViewSchema>;

export const eventEvidenceViewSchema = z.strictObject({
  eventId: z.number().int().positive(),
  claims: z.array(claimViewSchema),
});

export type EventEvidenceView = z.infer<typeof eventEvidenceViewSchema>;
