import type { TaskId } from "@hobbots/domain";
import { QuestCard } from "./quest-card.tsx";
import { LeadAnsweredLine, QuestionCard } from "./question-card.tsx";
import type { HobLookup } from "./use-work.ts";
import type { Moment } from "./work-model.ts";

/**
 * What the chat shows of a request's work under one message: the Task or Quest card, a question
 * that reached you, or a lead's answer that spared you one. Everything else stays on the card.
 */
export function WorkMoments({
  moments,
  hobs,
  onOpen,
}: {
  moments: ReadonlyArray<Moment>;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  return moments.map((moment) =>
    moment.kind === "card" ? (
      <QuestCard key={`card-${moment.tree.tasks[0]?.id}`} tree={moment.tree} hobs={hobs} onOpen={onOpen} />
    ) : moment.kind === "question" ? (
      <QuestionCard
        key={`question-${moment.question.id}`}
        tree={moment.tree}
        question={moment.question}
        hobs={hobs}
        onOpen={onOpen}
      />
    ) : (
      <LeadAnsweredLine key={`answered-${moment.question.id}`} question={moment.question} hobs={hobs} />
    ),
  );
}
