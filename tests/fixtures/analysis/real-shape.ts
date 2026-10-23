// Shape of tests/fixtures/analysis/real/*.json: one public article each, used
// by scripts/try-analysis.ts and tests/seed.test.ts.
import { z } from "zod";

export const realFixture = z.strictObject({
  /** Slug of a seeded industry. */
  industry: z.string().min(1),
  url: z.url(),
  title: z.string().min(1),
  /** Name of the source, as the source column would hold it. */
  source: z.string().min(1),
  /** ISO 8601 with a time zone. */
  published_at: z.iso.datetime(),
  summary: z.string().min(1),
  body: z.string().min(1),
});

export type RealFixture = z.infer<typeof realFixture>;
