export function Disclaimer({ text }: { text: string }) {
  return (
    <aside
      role="note"
      className="flex items-start gap-2 border-2 border-sec bg-card px-3 py-2 text-sm leading-snug"
    >
      <span className="mt-px shrink-0 bg-sec px-1.5 py-0.5 font-mono text-[0.68rem] font-bold uppercase tracking-widest text-background">
        Notice
      </span>
      <span>{text}</span>
    </aside>
  );
}
