import type { FinanceConceptExplainer } from "../../lib/artifacts/types";

export function FinanceConceptCard({
  concept,
}: {
  concept: FinanceConceptExplainer;
}) {
  return (
    <section
      aria-label="Finance Concepts for Learners"
      className="border-t border-border pt-6"
    >
      <header className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <span className="text-xs font-bold text-muted-foreground">
          💡 Finance Concepts for Learners
        </span>
        <span className="text-[0.68rem] text-muted-foreground">
          Core Financial Principles
        </span>
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-heading text-lg font-semibold text-foreground tracking-tight">
            {concept.conceptName}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-foreground">
            {concept.plainEnglishDefinition}
          </p>
        </div>

        <div className="border-l-2 border-border-strong pl-3 text-xs leading-relaxed">
          <h4 className="text-xs font-bold text-muted-foreground">
            Application in This Story
          </h4>
          <p className="mt-1 text-foreground">{concept.applicationInStory}</p>
        </div>

        {concept.commonPitfalls.length > 0 && (
          <div className="border border-dashed border-border-strong p-3 text-xs">
            <h4 className="text-xs font-bold text-foreground">
              Common Misconceptions & Pitfalls
            </h4>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-relaxed text-foreground">
              {concept.commonPitfalls.map((pitfall, idx) => (
                <li key={idx}>{pitfall}</li>
              ))}
            </ul>
          </div>
        )}

        {concept.keyTakeaways.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">
              Key Evaluation Takeaways
            </h4>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-foreground">
              {concept.keyTakeaways.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
