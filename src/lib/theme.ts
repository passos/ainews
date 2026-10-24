import { PREFS_KEY } from "./reader-prefs";
import type { Theme } from "./reader-prefs";

// Runs in <head> before first paint, so a stored dark choice does not flash
// light. Default is light: only the exact value "dark" sets the attribute.
// Storage that throws or holds bad JSON means light. It must never throw.
export const THEME_INIT_SCRIPT = `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(PREFS_KEY)}));if(p&&typeof p==="object"&&p.theme==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

/** Browser side: the CSS reads `:root[data-theme="dark"]`. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}
