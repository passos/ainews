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

export const evidenceSchema = z
  .object({ quote: z.string().min(1).max(2000) })
  .strict();
const name = z.string().trim().min(1).max(200);
const amount = z.number().int().safe().nonnegative();
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });
const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());
const names = z.array(name).max(50);
const reported = <T extends z.ZodType>(value: T) =>
  z.object({ value, evidence: evidenceSchema }).strict();
const set = <T extends z.ZodType>(value: T) =>
  z.object({ op: z.literal("set"), value, evidence: evidenceSchema }).strict();
const clear = z
  .object({ op: z.literal("clear"), evidence: evidenceSchema })
  .strict();
const listPatch = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("replace"),
      values: names,
      evidence: evidenceSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("delta"),
      add: names,
      remove: names,
      evidence: evidenceSchema,
    })
    .strict()
    .refine(
      (value) =>
        !value.add.some((name) =>
          value.remove.some(
            (removed) =>
              removed.trim().toLowerCase() === name.trim().toLowerCase(),
          ),
        ),
    ),
]);
export const fundingPatchSchema = z
  .object({
    companyName: set(name).optional(),
    roundName: set(name.max(100)).optional(),
    amount: z.union([set(amount), clear]).optional(),
    currency: set(currency).optional(),
    valuation: z.union([set(amount), clear]).optional(),
    announcedDate: z.union([set(isoDateSchema), clear]).optional(),
    sector: set(z.enum(FUNDING_SECTORS)).optional(),
    stage: set(z.enum(FUNDING_STAGES)).optional(),
    investors: listPatch.optional(),
    leadInvestors: listPatch
      .refine((operation) =>
        operation.op === "replace"
          ? operation.values.length <= 20
          : operation.add.length <= 20 && operation.remove.length <= 20,
      )
      .optional(),
  })
  .strict();
export const fundingIdentitySchema = z
  .object({
    companyName: reported(name),
    roundName: reported(name.max(100)),
    companyHost: reported(z.string().min(1).max(500)).nullable(),
    announcedDate: reported(z.string().min(1).max(80)).nullable(),
    sameEventEvidence: evidenceSchema.nullable(),
  })
  .strict();
export const reportedFundingFactsSchema = z
  .object({
    amount: reported(amount.nullable()).optional(),
    currency: reported(currency).optional(),
    valuation: reported(amount.nullable()).optional(),
    sector: reported(z.enum(FUNDING_SECTORS)).optional(),
    stage: reported(z.enum(FUNDING_STAGES)).optional(),
    announcedDate: reported(isoDateSchema.nullable()).optional(),
    investors: reported(names).optional(),
    leadInvestors: reported(z.array(name).max(20)).optional(),
  })
  .strict();
export const extractedRoundSchema = z
  .object({
    identity: fundingIdentitySchema,
    reportedFacts: reportedFundingFactsSchema,
    correctionPatch: fundingPatchSchema,
    correctionReason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type ExtractedRound = z.infer<typeof extractedRoundSchema>;
export type FundingPatch = z.infer<typeof fundingPatchSchema>;
export const extractedFundingBatchSchema = z
  .object({
    version: z.literal(2),
    rounds: z.array(extractedRoundSchema).max(10),
  })
  .strict();
export type ExtractedFundingBatch = z.infer<typeof extractedFundingBatchSchema>;

export const fundingResolutionSchema = z
  .object({
    companyKey: z.string().min(1).max(1000),
    roundKey: z.string().min(1).max(500),
    companyName: name,
    roundName: name,
    companyHost: z.string().min(1).max(500).nullable(),
    announcedDate: isoDateSchema.nullable(),
    concreteRound: z.string().min(1).max(100),
    source: z.enum(["automatic", "manual"]),
  })
  .strict();
export type ConfirmedFundingIdentity = z.infer<typeof fundingResolutionSchema>;
const observationAction = {
  observationId: z.string().min(1).max(500),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(500),
};
/** The three administrator actions on an unresolved funding observation. */
export const fundingObservationActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("attach_existing"),
      roundId: z.number().int().positive(),
      ...observationAction,
    })
    .strict(),
  z
    .object({
      action: z.literal("confirm_new"),
      companyName: name,
      roundName: name.max(100),
      announcedDate: isoDateSchema.nullable(),
      ...observationAction,
    })
    .strict(),
  z.object({ action: z.literal("reject"), ...observationAction }).strict(),
]);
export type FundingObservationAction = z.infer<
  typeof fundingObservationActionSchema
>;
export interface FundingFacts {
  companyName: string;
  roundName: string;
  amount: number | null;
  currency: string;
  valuation: number | null;
  sector: string;
  stage: FundingStage;
  announcedDate: string | null;
  investors: string[];
  leadInvestors: string[];
}

export interface FundingSourceArticle {
  articleId: number;
  bodySha: string;
  url: string;
  title: string;
  seenAt: number;
  observationId?: string;
  decisionRevision?: number;
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
