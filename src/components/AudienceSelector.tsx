import { Link } from "@tanstack/react-router";
import {
  AUDIENCES,
  readPrefs,
  withAudience,
  writePrefs,
} from "../lib/reader-prefs";
import type { Audience } from "../lib/reader-prefs";
import { cn } from "../lib/utils";
import { buttonVariants } from "./ui/button";

const LABELS: Record<Audience, string> = {
  student: "Student",
  educator: "Educator",
  professional: "Professional",
};

/**
 * "Explain for" choice. Plain links with a search param, so it works without
 * JavaScript. A click also stores the choice in this browser only.
 */
export function AudienceSelector({
  current,
}: {
  current: Audience | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        id="audience-label"
        className="font-mono text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground"
      >
        Explain for
      </span>
      <div
        role="group"
        aria-labelledby="audience-label"
        className="flex flex-wrap gap-1"
      >
        {AUDIENCES.map((audience) => (
          <Link
            key={audience}
            to="."
            search={(prev) => ({ ...prev, audience })}
            aria-current={current === audience ? "true" : undefined}
            onClick={() => writePrefs(withAudience(readPrefs(), audience))}
            className={cn(
              buttonVariants({ variant: "outline", size: "xs" }),
              "rounded-sm border-2 font-mono text-[0.68rem] font-bold uppercase tracking-wider",
              "aria-[current=true]:bg-primary aria-[current=true]:text-primary-foreground",
              // The router sets aria-current="page" on the active link and
              // overrides the "true" above.
              "aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground",
            )}
          >
            {LABELS[audience]}
          </Link>
        ))}
      </div>
    </div>
  );
}
