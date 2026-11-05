import type { Question, TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { AnswerForm } from "./answer-form.tsx";
import { messages } from "./messages.ts";
import { AnsweredChoices } from "./question-choices.tsx";
import type { HobLookup } from "./use-work.ts";
import { taskTitle } from "./work-model.ts";
import { yourAnswer } from "./your-answer.ts";

const copy = messages.question;

/**
 * A question that climbed every lead and reached you (ADR 018). Your answer goes back down the same
 * chain to the hob that asked; once answered, the card keeps your answer, and once its Task ends
 * unanswered, it says the question was withdrawn.
 */
export function QuestionCard({
  tree,
  question,
  hobs,
  onOpen,
}: {
  tree: TaskTree;
  question: Question;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const asker = hobs(question.askerId);
  const task = tree.tasks.find((each) => each.id === question.taskId);
  const open = question.state === "open";
  return (
    <section
      aria-label={copy.asks({ name: asker.name })}
      className={cn(
        "cut ms-9 flex max-w-work-max animate-hb-in flex-col gap-2.5 border-(length:--edge) bg-card px-3.5 py-3",
        open ? "border-lantern" : question.state === "withdrawn" ? "border-control" : "border-mint-deep",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <HobSprite hob={asker} size={20} state={open ? "needs-you" : "idle"} />
        <span className="lbl text-lantern">{copy.asks({ name: asker.name })}</span>
        {task !== undefined && (
          // A brief can run to a paragraph with a long path in it: the line wraps inside the card and
          // stops at two lines, and the whole brief is in the task it opens (#874).
          <Button variant="text" size="xs" className="max-w-full shrink" onClick={() => onOpen(task.id)}>
            <span className="line-clamp-2 text-start whitespace-normal">{copy.about({ title: taskTitle(task) })}</span>
          </Button>
        )}
      </div>
      <p className="m-0 leading-normal whitespace-pre-wrap">{question.text}</p>
      {open ? (
        <AnswerForm question={question} askerName={asker.name} via="chat" />
      ) : question.state === "withdrawn" ? (
        <p className="m-0 animate-hb-in text-ui text-text-secondary">{copy.withdrawn}</p>
      ) : (
        question.answer !== null && (
          <div className="flex animate-hb-in flex-col gap-0.5">
            <p className="m-0 text-ui text-mint">{yourAnswer(question, "chat")}</p>
            <AnsweredChoices question={question} />
          </div>
        )
      )}
    </section>
  );
}

/**
 * Where your answer to a question goes: back down the leads it climbed, so to the top one, who
 * passes it on (ADR 018), or straight to the hob that asked when no lead passed it up.
 */
export const answerRoute = (question: Question, hobs: HobLookup): string => {
  const asker = hobs(question.askerId).name;
  const lead = question.chain.at(-1);
  return lead === undefined ? copy.goesStraight({ asker }) : copy.goesThrough({ lead: hobs(lead).name, asker });
};

/** A lead answered a member's question itself, so it never reached you: one quiet line. */
export function LeadAnsweredLine({ question, hobs }: { question: Question; hobs: HobLookup }) {
  if (question.answeredBy?._tag !== "Lead") return null;
  const lead = hobs(question.answeredBy.agentId);
  const asker = hobs(question.askerId);
  return (
    <p className="ms-9 my-0 flex max-w-work-max animate-hb-in items-start gap-2 text-detail text-text-secondary">
      <HobSprite hob={lead} size={16} />
      <span className="flex flex-col gap-0.5">
        <span className="font-bold text-text-strong">{copy.leadAnswered({ lead: lead.name, asker: asker.name })}</span>
        <span>{question.text}</span>
        <span className="text-mint">{question.answer}</span>
      </span>
    </p>
  );
}
