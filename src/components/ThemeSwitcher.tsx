import { useEffect, useState } from "react";
import { THEMES, readPrefs, withTheme, writePrefs } from "../lib/reader-prefs";
import type { Theme } from "../lib/reader-prefs";
import { applyTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { buttonVariants } from "./ui/button";

const LABELS: Record<Theme, string> = { light: "Light", dark: "Dark" };

// Before mount the selected look comes from CSS (`dark:` and `not-dark:`
// follow `data-theme` on <html>), so server and client HTML match. After
// mount `aria-pressed` takes over. The button variant's hover rules
// (`hover:bg-muted`, `dark:hover:bg-input/50`) are as specific as a plain
// aria rule, so the hovered-and-pressed rules are one attribute more specific.
// Literal class names: Tailwind finds them by scanning the source.
const SELECTED_CLASS: Record<Theme, string> = {
  light: "not-dark:bg-primary not-dark:text-primary-foreground",
  dark: "dark:bg-primary dark:text-primary-foreground",
};

/**
 * Light / Dark choice, stored in this browser only. The server always renders
 * light; the head script applies a stored dark choice before first paint.
 * Without JavaScript the buttons do nothing.
 */
export function ThemeSwitcher() {
  // Unknown until mounted: SSR output must not depend on the reader.
  const [theme, setTheme] = useState<Theme | undefined>(undefined);
  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    );
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        id="theme-label"
        className="text-[0.68rem] font-bold text-muted-foreground"
      >
        Theme
      </span>
      <div
        role="group"
        aria-labelledby="theme-label"
        className="flex flex-wrap gap-1"
      >
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={theme === undefined ? undefined : theme === t}
            onClick={() => {
              applyTheme(t);
              writePrefs(withTheme(readPrefs(), t));
              setTheme(t);
            }}
            className={cn(
              buttonVariants({ variant: "outline", size: "xs" }),
              "border text-[0.68rem] font-bold",
              SELECTED_CLASS[t],
              "aria-[pressed=true]:bg-primary aria-[pressed=true]:text-primary-foreground hover:aria-[pressed=true]:bg-primary dark:hover:aria-[pressed=true]:bg-primary",
            )}
          >
            {LABELS[t]}
          </button>
        ))}
      </div>
    </div>
  );
}
