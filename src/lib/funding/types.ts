import { z } from "zod";

/** Stage buckets stored in funding_rounds.stage (matches the table CHECK). */
export const FUNDING_STAGES = [
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
  "series_d_plus",
  "growth",
  "grant",
  "debt",
  "undisclosed",
] as const;
export type FundingStage = (typeof FUNDING_STAGES)[number];

export const FUNDING_STATUSES = [
  "published",
  "pending_review",
  "rejected",
] as const;
export type FundingStatus = (typeof FUNDING_STATUSES)[number];

export const FUNDING_SECTORS = [
  "ai_infrastructure",
  "ai_applications",
  "developer_tools",
  "enterprise_saas",
  "fintech",
  "healthcare",
  "education",
  "robotics",
  "semiconductors",
  "cybersecurity",
  "climate_energy",
  "consumer",
  "other",
] as const;
export type FundingSector = (typeof FUNDING_SECTORS)[number];

/**
 * The model's answer for one article. The model reports what the article
 * says; keys, stage buckets and micro-USD are computed in code
 * (normalize.ts), never taken from the model.
 */
export const extractedRoundSchema = z.object({
  isFundingAnnouncement: z.boolean(),
  companyName: z.string().min(1).max(200),
  roundName: z.string().min(1).max(100),
  amount: z.number().int().safe().nonnegative().nullable().optional(),
  currency: z.string().min(3).max(3).nullable().optional(),
  valuation: z.number().int().safe().nonnegative().nullable().optional(),
  sector: z.string().max(100).nullable().optional(),
  investors: z.array(z.string().min(1).max(200)).max(50).default([]),
  leadInvestors: z.array(z.string().min(1).max(200)).max(20).default([]),
  announcedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  isCorrectionOrUpdate: z.boolean().optional(),
  correctionReason: z.string().max(500).nullable().optional(),
});
export type ExtractedRound = z.infer<typeof extractedRoundSchema>;

export const extractedFundingBatchSchema = z.object({
  rounds: z.array(extractedRoundSchema).max(10),
});
export type ExtractedFundingBatch = z.infer<typeof extractedFundingBatchSchema>;

export interface FundingSourceArticle {
  articleId: number;
  bodySha: string;
  url: string;
  title: string;
  seenAt: number;
}

export const fundingCorrectionSchema = z.object({
  roundId: z.number().int().positive(),
  amount: z.number().int().safe().nonnegative().nullable(),
  currency: z
    .string()
    .trim()
    .regex(/^[a-zA-Z]{3}$/)
    .transform((v) => v.toUpperCase()),
  reason: z.string().trim().min(3).max(500),
});
