// Reader preferences, stored only in the reader's browser (localStorage key
// `pn:prefs:v1`). The server never sees them, so SSR output does not depend
// on them. #17 adds `watches` to the same key: unknown fields are kept.

export const AUDIENCES = ["student", "educator", "professional"] as const;
export type Audience = (typeof AUDIENCES)[number];

export interface ReaderPrefs {
  audience?: Audience;
  /** Section slugs the reader follows. */
  sections?: string[];
  [unknown: string]: unknown;
}

export const PREFS_KEY = "pn:prefs:v1";

export function isAudience(value: unknown): value is Audience {
  return AUDIENCES.includes(value as Audience);
}

/** Invalid JSON, a non-object, or an invalid field means "no preference". */
export function parsePrefs(raw: string | null): ReaderPrefs {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const prefs: ReaderPrefs = { ...(value as Record<string, unknown>) };
  if (!isAudience(prefs.audience)) delete prefs.audience;
  if (
    !Array.isArray(prefs.sections) ||
    !prefs.sections.every((s) => typeof s === "string")
  ) {
    delete prefs.sections;
  }
  return prefs;
}

export function serializePrefs(prefs: ReaderPrefs): string {
  return JSON.stringify(prefs);
}

export function withAudience(prefs: ReaderPrefs, audience: Audience) {
  return { ...prefs, audience };
}

export function toggleSection(prefs: ReaderPrefs, slug: string): ReaderPrefs {
  const current = prefs.sections ?? [];
  const sections = current.includes(slug)
    ? current.filter((s) => s !== slug)
    : [...current, slug];
  return { ...prefs, sections };
}

// Browser side. Every access is guarded: private mode and blocked storage
// throw, and that must never break the page.

export function readPrefs(): ReaderPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return {};
  }
}

export function writePrefs(prefs: ReaderPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, serializePrefs(prefs));
  } catch {
    // Not stored; the page works without it.
  }
}
