import type { ReactNode } from "react";

/**
 * The head of one section on a story page (#87 A3a): one h2 in one style, then
 * a short grey note on the same line. `children` sit at the end of the row
 * (tier switches, badges).
 */
export function SectionHead({
  title,
  note,
  children,
}: {
  title: string;
  note: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-heading text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      {children}
    </header>
  );
}
