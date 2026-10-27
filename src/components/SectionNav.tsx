import { Link } from "@tanstack/react-router";
import { cn } from "../lib/utils";

export interface NavSection {
  slug: string;
  name: string;
}

/** Class names of one header navigation item. */
export const NAV_ITEM_CLASS = cn(
  "inline-flex min-h-11 items-center border-b-2 border-transparent px-1 text-[0.95rem] no-underline",
  "hover:border-border-strong",
  "aria-[current=page]:border-foreground aria-[current=page]:font-semibold",
);

export function SectionNav({ sections }: { sections: NavSection[] }) {
  return (
    <nav aria-label="Sections" className="flex flex-wrap gap-x-5 gap-y-0">
      {sections.map((s) => (
        <Link
          key={s.slug}
          to="/s/$section"
          params={{ section: s.slug }}
          // Keep the reader's audience: a click must not drop it.
          search={(prev) => ({ audience: prev.audience })}
          data-section={s.slug}
          className={NAV_ITEM_CLASS}
        >
          {s.name}
        </Link>
      ))}
    </nav>
  );
}

/** Header link to the topic watch list. Shown only while watches exist. */
export function WatchesNavLink() {
  return (
    <Link
      to="/w"
      search={(prev) => ({ audience: prev.audience })}
      data-nav="watches"
      className={NAV_ITEM_CLASS}
    >
      Watches
    </Link>
  );
}
