import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { readPrefs } from "../lib/reader-prefs";

/** "Your sections": rendered on the client only; empty during SSR. */
export function YourSections({
  sections,
}: {
  sections: { slug: string; name: string }[];
}) {
  const [followed, setFollowed] = useState<string[]>([]);
  useEffect(() => {
    setFollowed(readPrefs().sections ?? []);
  }, []);
  const mine = sections.filter((s) => followed.includes(s.slug));
  if (mine.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b-2 pb-2 font-mono text-xs uppercase tracking-wider">
      <span className="font-bold text-muted-foreground">Your sections</span>
      {mine.map((s) => (
        <Link
          key={s.slug}
          to="/s/$section"
          params={{ section: s.slug }}
          search={(prev) => ({ audience: prev.audience })}
          data-section={s.slug}
          className="font-bold text-sec-ink underline"
        >
          {s.name}
        </Link>
      ))}
    </p>
  );
}
