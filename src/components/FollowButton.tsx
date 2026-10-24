import { useEffect, useState } from "react";
import { readPrefs, toggleSection, writePrefs } from "../lib/reader-prefs";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

/** Follow / Following for a section; stored in this browser only. */
export function FollowButton({ slug }: { slug: string }) {
  // Server and first client render both show "Follow".
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    setFollowing(readPrefs().sections?.includes(slug) ?? false);
  }, [slug]);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={following}
      onClick={() => {
        const next = toggleSection(readPrefs(), slug);
        writePrefs(next);
        setFollowing(next.sections?.includes(slug) ?? false);
      }}
      className={cn(
        "rounded-sm border-2 font-mono text-xs font-bold uppercase tracking-wider",
        "aria-pressed:bg-primary aria-pressed:text-primary-foreground",
      )}
    >
      {following ? "Following" : "Follow"}
    </Button>
  );
}
