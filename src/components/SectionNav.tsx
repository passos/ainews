import { Link } from "@tanstack/react-router";
import { buttonVariants } from "./ui/button";
import { cn } from "../lib/utils";

export interface NavSection {
  slug: string;
  name: string;
}

export function SectionNav({ sections }: { sections: NavSection[] }) {
  return (
    <nav aria-label="Sections" className="flex flex-wrap gap-1">
      {sections.map((s) => (
        <Link
          key={s.slug}
          to="/s/$section"
          params={{ section: s.slug }}
          // Keep the reader's audience: a click must not drop it.
          search={(prev) => ({ audience: prev.audience })}
          data-section={s.slug}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "rounded-sm border-2 font-mono text-xs font-bold uppercase tracking-wider",
            "hover:bg-sec hover:text-background",
            "aria-[current=page]:border-sec aria-[current=page]:bg-sec aria-[current=page]:text-background",
          )}
        >
          <span aria-hidden="true" className="size-2 bg-sec" />
          {s.name}
        </Link>
      ))}
    </nav>
  );
}
