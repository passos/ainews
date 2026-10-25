// Reader preferences, stored only in the reader's browser (localStorage key
// `pn:prefs:v1`). The server never sees them, so SSR output does not depend
// on them. #17 adds `watches` to the same key: unknown fields are kept.

export const AUDIENCES = ["student", "educator", "professional"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export interface ReaderPrefs {
  audience?: Audience;
  /** Missing means light: the site does not follow the system setting. */
  theme?: Theme;
  /** Section slugs the reader follows. */
  sections?: string[];
  /** Topic watch slugs the reader follows. */
  watches?: string[];
  [unknown: string]: unknown;
}

export const PREFS_KEY = "pn:prefs:v1";

export function isAudience(value: unknown): value is Audience {
  return AUDIENCES.includes(value as Audience);
}

export function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme);
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
  if (!isTheme(prefs.theme)) delete prefs.theme;
  if (
    !Array.isArray(prefs.sections) ||
    !prefs.sections.every((s) => typeof s === "string")
  ) {
    delete prefs.sections;
  }
  if (
    !Array.isArray(prefs.watches) ||
    !prefs.watches.every((s) => typeof s === "string")
  ) {
    delete prefs.watches;
  }
  return prefs;
}

export function serializePrefs(prefs: ReaderPrefs): string {
  return JSON.stringify(prefs);
}

export function withAudience(prefs: ReaderPrefs, audience: Audience) {
  return { ...prefs, audience };
}

export function withTheme(prefs: ReaderPrefs, theme: Theme): ReaderPrefs {
  return { ...prefs, theme };
}

export function toggleSection(prefs: ReaderPrefs, slug: string): ReaderPrefs {
  const current = prefs.sections ?? [];
  const sections = current.includes(slug)
    ? current.filter((s) => s !== slug)
    : [...current, slug];
  return { ...prefs, sections };
}

export function toggleWatch(prefs: ReaderPrefs, slug: string): ReaderPrefs {
  const current = prefs.watches ?? [];
  const watches = current.includes(slug)
    ? current.filter((s) => s !== slug)
    : [...current, slug];
  return { ...prefs, watches };
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
