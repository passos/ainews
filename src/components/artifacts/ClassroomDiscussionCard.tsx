import type { ClassroomDiscussionBuilder } from "../../lib/artifacts/types";

export function ClassroomDiscussionCard({
  guide,
}: {
  guide: ClassroomDiscussionBuilder;
}) {
  return (
    <section
      aria-label="Classroom Discussion Builder"
      className="border border-border bg-card p-4 sm:p-5"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-muted-foreground">
            🎓 Classroom Discussion Builder
          </span>
          <span className="text-[0.68rem] text-muted-foreground">
            Pedagogical Facilitation
          </span>
        </div>
        {guide.gradeLevels.length > 0 && (
          <div className="flex items-center gap-1">
            {guide.gradeLevels.map((lvl, idx) => (
              <span
                key={idx}
                className="bg-muted px-2 py-0.5 text-[0.68rem] text-foreground"
              >
                {lvl}
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="flex flex-col gap-4">
        <div>
          <h4 className="text-xs font-bold text-muted-foreground">
            Central Inquiry Topic
          </h4>
          <p className="mt-1 font-heading text-base font-semibold text-foreground tracking-tight">
            {guide.topic}
          </p>
        </div>

        {guide.discussionQuestions.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">
              Guiding Discussion Questions & Learning Goals
            </h4>
            <div className="mt-2 flex flex-col gap-2">
              {guide.discussionQuestions.map((item, idx) => (
                <div
                  key={idx}
                  className="border border-border/80 bg-muted/20 p-3 text-xs leading-relaxed"
                >
                  <p className="font-semibold text-foreground">
                    {idx + 1}. {item.question}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    <span className="font-bold text-muted-foreground">
                      Goal:
                    </span>{" "}
                    {item.learningGoal}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {guide.classroomActivities.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">
              Structured Classroom Activities
            </h4>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {guide.classroomActivities.map((act, idx) => (
                <div
                  key={idx}
                  className="flex flex-col border border-border bg-card p-3 text-xs"
                >
                  <h5 className="text-xs font-bold text-muted-foreground">
                    {act.activity}
                  </h5>
                  <p className="mt-1.5 leading-relaxed text-foreground">
                    {act.instructions}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
