import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { readPrefs } from "../lib/reader-prefs";
import type { Audience } from "../lib/reader-prefs";

/**
 * After hydration only: when the URL has no `audience` but this browser has a
 * stored one, add it to the URL. SSR never reads the stored choice, so server
 * and client HTML match. URL beats stored choice beats default.
 */
export function PrefsSync({ audience }: { audience: Audience | undefined }) {
  const navigate = useNavigate();
  useEffect(() => {
    if (audience) return;
    const stored = readPrefs().audience;
    if (stored) {
      void navigate({
        to: ".",
        search: (prev) => ({ ...prev, audience: stored }),
        replace: true,
      });
    }
  }, [audience, navigate]);
  return null;
}
