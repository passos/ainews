import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { readPrefs } from "../lib/reader-prefs";

/** "Your sections & topics": rendered on the client only; empty during SSR. */
export function YourSections({
  sections,
  watches = [],
}: {
  sections: { slug: string; name: string }[];
  watches?: { slug: string; question: string }[];
}) {
  const [followedSections, setFollowedSections] = useState<string[]>([]);
  const [followedWatches, setFollowedWatches] = useState<string[]>([]);

  useEffect(() => {
    const prefs = readPrefs();
    setFollowedSections(prefs.sections ?? []);
    setFollowedWatches(prefs.watches ?? []);
  }, []);

  const mineSections = sections.filter((s) =>
    followedSections.includes(s.slug),
  );
  const mineWatches = watches.filter((w) => followedWatches.includes(w.slug));

  if (mineSections.length === 0 && mineWatches.length === 0) return null;

  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-2 text-xs">
      <span className="font-bold text-muted-foreground">Your follows</span>
      {mineSections.map((s) => (
        <Link
          key={s.slug}
          to="/s/$section"
          params={{ section: s.slug }}
          search={(prev) => ({ audience: prev.audience })}
          data-section={s.slug}
          className="font-bold text-foreground underline"
        >
          {s.name}
        </Link>
      ))}
      {mineWatches.map((w) => (
        <Link
          key={w.slug}
          to="/w/$watch"
          params={{ watch: w.slug }}
          search={(prev) => ({ audience: prev.audience })}
          data-watch={w.slug}
          className="font-bold text-foreground underline"
        >
          [Watch] {w.question.slice(0, 30)}...
        </Link>
      ))}
    </p>
  );
}
