export function Disclaimer({ text }: { text: string }) {
  return (
    <aside
      role="note"
      className="flex items-start gap-2 border border-border-strong bg-card px-3 py-2 text-sm leading-snug"
    >
      <span className="shrink-0 font-semibold">Notice</span>
      <span>{text}</span>
    </aside>
  );
}
