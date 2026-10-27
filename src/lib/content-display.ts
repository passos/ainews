// How much of a source's body the reader page may show (licensing, N§6).
// Strings and zod only: the admin routes import it for the select box.
import { z } from "zod";

export const CONTENT_DISPLAYS = ["full", "excerpt", "summary"] as const;
export type ContentDisplay = (typeof CONTENT_DISPLAYS)[number];
/** What a new source starts with (admin form, createSource, seed). */
export const DEFAULT_CONTENT_DISPLAY: ContentDisplay = "full";
/** What an unreadable stored value means: show less, not more. */
const FALLBACK_CONTENT_DISPLAY: ContentDisplay = "excerpt";
export const contentDisplaySchema = z.enum(CONTENT_DISPLAYS);

/** Unknown values read as "excerpt": show less, not more. */
export function parseContentDisplay(value: unknown): ContentDisplay {
  return (CONTENT_DISPLAYS as readonly unknown[]).includes(value)
    ? (value as ContentDisplay)
    : FALLBACK_CONTENT_DISPLAY;
}
