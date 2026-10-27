import { readPrefs, withTheme, writePrefs } from "../lib/reader-prefs";
import { applyTheme } from "../lib/theme";

const ICON = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const TITLE = {
  light: "Switch to dark theme",
  dark: "Switch to light theme",
} as const;

// The tooltip cannot be picked by CSS, so it follows <html> after mount. The
// server markup is unchanged, so hydration does not see a difference.
function syncTitle(el: HTMLButtonElement | null) {
  if (el) {
    el.title =
      TITLE[
        document.documentElement.dataset.theme === "dark" ? "dark" : "light"
      ];
  }
}

/**
 * Light / Dark toggle, stored in this browser only. The server always renders
 * light; the head script applies a stored dark choice before first paint.
 * Both icons and both labels are in the markup and CSS picks one (`dark:`
 * follows `data-theme` on <html>), so server and client HTML match and the
 * accessible name is right before mount. The click reads the current theme
 * from <html>, so there is no mount state. Without JavaScript it does nothing.
 * Literal class names: Tailwind finds them by scanning the source.
 */
export function ThemeSwitcher() {
  return (
    <button
      type="button"
      ref={syncTitle}
      title={TITLE.light}
      onClick={(e) => {
        const next =
          document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        applyTheme(next);
        writePrefs(withTheme(readPrefs(), next));
        syncTitle(e.currentTarget);
      }}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Moon: shown in light, click goes dark. */}
      <svg {...ICON} className="dark:hidden">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
      {/* Sun: shown in dark, click goes light. */}
      <svg {...ICON} className="hidden dark:block">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      <span className="sr-only dark:hidden">Switch to dark theme</span>
      <span className="sr-only hidden dark:inline">Switch to light theme</span>
    </button>
  );
}
