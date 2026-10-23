// `sources.config` (JSON). #6 reads it too.
import { z } from "zod";

export const SourceConfig = z.strictObject({
  /** html sources: CSS selectors for the list page. */
  list: z
    .strictObject({
      /** One element per entry. */
      item: z.string().min(1),
      /** Default: the item itself if it is an <a>, else its first a[href]. */
      link: z.string().min(1).optional(),
      /** Default: the link text. */
      title: z.string().min(1).optional(),
      /** Default: the first <time> in the item. */
      date: z.string().min(1).optional(),
      /** Attribute read before the element text. Default: "datetime". */
      dateAttr: z.string().min(1).optional(),
    })
    .optional(),
  /** Drop an entry if any value of child element `field` is in `values`. */
  exclude: z
    .array(z.strictObject({ field: z.string(), values: z.array(z.string()) }))
    .optional(),
  /** The feed summary is the whole article (used by #6). */
  summaryIsBody: z.boolean().optional(),
});

export type SourceConfig = z.infer<typeof SourceConfig>;

/** Throws if the JSON or its shape is invalid. */
export function parseSourceConfig(json: string): SourceConfig {
  return SourceConfig.parse(JSON.parse(json));
}

export function isExcluded(
  fields: Record<string, string[]>,
  exclude: SourceConfig["exclude"],
): boolean {
  return (exclude ?? []).some((rule) =>
    (fields[rule.field] ?? []).some((value) => rule.values.includes(value)),
  );
}
