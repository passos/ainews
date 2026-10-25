import { useEffect, useMemo, useState } from "react";
import {
  type ArtifactAudience,
  type LearningMaterial,
  ARTIFACT_AUDIENCES,
} from "../../lib/artifacts/types";

export function LearningMaterialCard({
  materials,
  initialAudience,
}: {
  materials: Partial<Record<ArtifactAudience, LearningMaterial>>;
  initialAudience?: ArtifactAudience;
}) {
  const availableAudiences = useMemo(
    () => ARTIFACT_AUDIENCES.filter((aud) => !!materials[aud]),
    [materials],
  );

  const resolveAudience = (pref?: ArtifactAudience): ArtifactAudience => {
    if (pref && availableAudiences.includes(pref)) {
      return pref;
    }
    return availableAudiences[0] || "student";
  };

  const [selectedAudience, setSelectedAudience] = useState<ArtifactAudience>(
    () => resolveAudience(initialAudience),
  );

  const [selectedAnswers, setSelectedAnswers] = useState<
    Record<number, number>
  >({});

  useEffect(() => {
    if (initialAudience && availableAudiences.includes(initialAudience)) {
      setSelectedAudience(initialAudience);
    }
  }, [initialAudience, availableAudiences]);

  if (availableAudiences.length === 0) {
    return null;
  }

  const current =
    materials[selectedAudience] || materials[availableAudiences[0]];
  if (!current) {
    return null;
  }

  const handleSelectAnswer = (qIdx: number, optIdx: number) => {
    setSelectedAnswers((prev) => ({ ...prev, [qIdx]: optIdx }));
  };

  return (
    <section
      aria-label="Learning Materials"
      className="border-2 border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
            ★ News-to-Learning Interactive Materials
          </span>
          <p className="font-mono text-[0.68rem] text-muted-foreground">
            Curriculum, quizzes, discussion questions, and activities adapted by
            audience
          </p>
        </div>

        <nav
          aria-label="Learning audience tiers"
          className="flex items-center gap-1"
        >
          {availableAudiences.map((aud) => {
            const isSelected = aud === selectedAudience;
            return (
              <button
                key={aud}
                type="button"
                onClick={() => {
                  setSelectedAudience(aud);
                  setSelectedAnswers({});
                }}
                className={`rounded border px-2.5 py-1 font-mono text-xs font-bold uppercase tracking-wider transition-colors ${
                  isSelected
                    ? "border-sec-ink bg-sec-ink text-white dark:text-black"
                    : "border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {aud}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="flex flex-col gap-5">
        <div>
          <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Concept Explainer
          </h4>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground">
            {current.conceptExplainer}
          </p>
        </div>

        {current.glossary.length > 0 && (
          <div className="rounded border border-border/80 bg-muted/20 p-3">
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
              Glossary of Key Terms
            </h4>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              {current.glossary.map((item, idx) => (
                <div key={idx} className="flex flex-col">
                  <dt className="font-mono text-xs font-bold text-foreground">
                    {item.term}
                  </dt>
                  <dd className="text-xs text-muted-foreground">
                    {item.definition}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {current.quiz.length > 0 && (
          <div className="rounded border-2 border-sec/40 bg-card p-3 sm:p-4">
            <h4 className="font-mono text-xs font-bold uppercase tracking-widest text-sec-ink">
              Interactive Quiz & Comprehension Check
            </h4>
            <div className="mt-3 flex flex-col gap-4">
              {current.quiz.map((q, qIdx) => {
                const userChoice = selectedAnswers[qIdx];
                const hasAnswered = userChoice !== undefined;
                return (
                  <div
                    key={qIdx}
                    className="flex flex-col gap-2 rounded border border-border/60 bg-muted/10 p-3"
                  >
                    <p className="text-sm font-semibold text-foreground">
                      {qIdx + 1}. {q.question}
                    </p>
                    <div className="flex flex-col gap-1.5 pl-1">
                      {q.options.map((opt, optIdx) => {
                        const isChosen = userChoice === optIdx;
                        const isCorrect = q.answerIndex === optIdx;
                        let btnStyle =
                          "border-border bg-background hover:bg-muted text-foreground";
                        if (hasAnswered) {
                          if (isCorrect) {
                            btnStyle =
                              "border-green-600 bg-green-500/10 text-green-700 dark:text-green-300 font-semibold";
                          } else if (isChosen && !isCorrect) {
                            btnStyle =
                              "border-red-600 bg-red-500/10 text-red-700 dark:text-red-300 line-through";
                          } else {
                            btnStyle =
                              "border-border/40 opacity-60 text-muted-foreground";
                          }
                        }
                        return (
                          <button
                            key={optIdx}
                            type="button"
                            disabled={hasAnswered}
                            onClick={() => handleSelectAnswer(qIdx, optIdx)}
                            className={`flex items-center justify-between rounded border px-3 py-1.5 text-left text-xs transition-colors ${btnStyle}`}
                          >
                            <span>{opt}</span>
                            {hasAnswered && isCorrect && (
                              <span className="font-mono text-[0.7rem] font-bold text-green-600 dark:text-green-400">
                                ✓ Correct
                              </span>
                            )}
                            {hasAnswered && isChosen && !isCorrect && (
                              <span className="font-mono text-[0.7rem] font-bold text-red-600 dark:text-red-400">
                                ✗ Incorrect
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {hasAnswered && (
                      <p className="mt-1 border-l-2 border-sec pl-2 text-xs leading-relaxed text-muted-foreground">
                        <strong className="text-foreground">
                          Explanation:
                        </strong>{" "}
                        {q.explanation}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {current.discussionQuestions.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Inquiry & Discussion Questions
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm leading-relaxed text-foreground">
              {current.discussionQuestions.map((dq, idx) => (
                <li key={idx}>{dq}</li>
              ))}
            </ul>
          </div>
        )}

        {current.activities.length > 0 && (
          <div>
            <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Practical Activities & Exercises
            </h4>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm leading-relaxed text-foreground">
              {current.activities.map((act, idx) => (
                <li key={idx}>{act}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
