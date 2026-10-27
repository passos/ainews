import { useEffect, useState } from "react";
import {
  readPrefs,
  toggleSection,
  toggleWatch,
  writePrefs,
} from "../lib/reader-prefs";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

/** Follow / Following for a section or topic watch; stored in this browser only. */
export function FollowButton({
  slug,
  kind = "section",
}: {
  slug: string;
  kind?: "section" | "watch";
}) {
  // Server and first client render both show "Follow".
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    const prefs = readPrefs();
    const list = kind === "watch" ? prefs.watches : prefs.sections;
    setFollowing(list?.includes(slug) ?? false);
  }, [slug, kind]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={following}
      onClick={() => {
        const prefs = readPrefs();
        const next =
          kind === "watch"
            ? toggleWatch(prefs, slug)
            : toggleSection(prefs, slug);
        writePrefs(next);
        const list = kind === "watch" ? next.watches : next.sections;
        setFollowing(list?.includes(slug) ?? false);
      }}
      className={cn(
        "border text-xs font-bold",
        "aria-pressed:bg-primary aria-pressed:text-primary-foreground",
      )}
    >
      {following ? "Following" : "Follow"}
    </Button>
  );
}
