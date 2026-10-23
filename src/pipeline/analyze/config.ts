// AnalysisConfig: the per-industry part of the analysis, stored in
// industries.config under `analysis` (#8 fills it). Everything that is not
// industry-specific (labels, dimension definitions, formula) is in code.
import { z } from "zod";
import { LABEL_KEYS } from "./labels";
import type { LabelKey } from "./labels";

/** The five dimensions (AIHOT structure). */
export const DIMS = ["sig", "nov", "cred", "reson", "act"] as const;
export type Dim = (typeof DIMS)[number];

const text = z.string().trim().min(1);

/** Weights of one content type: integers that add up to 10. */
const weights = z
  .strictObject({
    sig: z.number().int().nonnegative(),
    nov: z.number().int().nonnegative(),
    cred: z.number().int().nonnegative(),
    reson: z.number().int().nonnegative(),
    act: z.number().int().nonnegative(),
  })
  .refine((w) => DIMS.reduce((sum, d) => sum + w[d], 0) === 10, {
    message: "weights must add up to 10",
  });

/** Five tiers per dimension, from low to high. */
const tiers = z.tuple([text, text, text, text, text]);

/** Caps on the 0-10 scale. */
const cap = z.number().min(0).max(10);

export const analysisConfigSchema = z.strictObject({
  prefilter: z.strictObject({ relevant: text, off_topic: text, noise: text }),
  categories: z.record(text, text).refine((c) => Object.keys(c).length >= 2, {
    message: "at least 2 categories",
  }),
  contentTypes: z
    .record(text, z.strictObject({ description: text, weights }))
    .refine((c) => Object.keys(c).length >= 1, {
      message: "at least 1 content type",
    }),
  dimensions: z.strictObject({
    sig: tiers,
    nov: tiers,
    cred: tiers,
    reson: tiers,
    act: tiers,
  }),
  noise: z
    .record(
      text,
      z.strictObject({
        description: text,
        caps: z.strictObject({
          sig: cap.optional(),
          nov: cap.optional(),
          cred: cap.optional(),
          reson: cap.optional(),
          act: cap.optional(),
        }),
      }),
    )
    .refine((n) => Object.hasOwn(n, "none"), {
      message: 'noise must have "none"',
    }),
  labels: z
    .array(z.enum(LABEL_KEYS as [LabelKey, ...LabelKey[]]))
    .refine((l) => new Set(l).size === l.length, {
      message: "labels must be unique",
    }),
  thresholds: z.strictObject({
    prefilterMinRelevant: z.number().min(0).max(1),
    select: z.number().min(0).max(100),
  }),
  summaryGuidance: z.string(),
  guardrails: z.array(text),
});

export type AnalysisConfig = z.infer<typeof analysisConfigSchema>;

/**
 * `analysis` of an industries.config JSON string. Null if the JSON, the key
 * or the shape is missing or wrong (the normal state before #8).
 */
export function parseAnalysisConfig(json: string): AnalysisConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const parsed = analysisConfigSchema.safeParse(
    (value as Record<string, unknown>).analysis,
  );
  return parsed.success ? parsed.data : null;
}
