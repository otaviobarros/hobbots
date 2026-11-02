import type { Question, TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useAnswerQuestion } from "../../api/questions.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { enterSends } from "./enter-sends.ts";
import { messages } from "./messages.ts";
import type { HobLookup } from "./use-work.ts";
import { taskTitle } from "./work-model.ts";

const copy = messages.question;

/**
 * A question that climbed every lead and reached you (ADR 018). Your answer goes back down the same
 * chain to the hob that asked; once answered, the card keeps your answer.
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
        "cut ms-9 flex max-w-work-max animate-hb-in flex-col gap-2.5 border-2 bg-card px-3.5 py-3",
        open ? "border-lantern" : "border-mint-deep",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <HobSprite hob={asker} size={20} state={open ? "needs-you" : "idle"} />
        <span className="lbl text-lantern">{copy.asks({ name: asker.name })}</span>
        {task !== undefined && (
          <Button variant="link" size="xs" onClick={() => onOpen(task.id)}>
            {copy.about({ title: taskTitle(task) })}
          </Button>
        )}
      </div>
      <p className="m-0 leading-normal whitespace-pre-wrap">{question.text}</p>
      {open ? (
        <AnswerForm question={question} askerName={asker.name} />
      ) : (
        question.answer !== null && (
          <p className="m-0 animate-hb-in text-sm text-mint">{copy.youAnswered({ answer: question.answer })}</p>
        )
      )}
    </section>
  );
}

export function AnswerForm({ question, askerName }: { question: Question; askerName: string }) {
  const [answer, setAnswer] = useState("");
  const send = useAnswerQuestion();
  const text = answer.trim();
  const submit = () => {
    if (text === "" || send.isPending) return;
    send.mutate({ questionId: question.id, answer: text });
  };
  const closed = send.error instanceof ApiError && send.error.tag === "QuestionClosed";
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={copy.answerLabel({ name: askerName })}
        placeholder={copy.answerPlaceholder}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={enterSends(submit)}
        className="min-h-10 rounded-none border-2 border-control bg-deep text-text"
      />
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={text === "" || send.isPending}>
          {send.isPending ? copy.sending : copy.send}
        </Button>
        {send.isError && (
          <span role="alert" className="text-sm text-rose">
            {closed ? copy.closed : copy.failed}
          </span>
        )}
      </span>
    </form>
  );
}

/** A lead answered a member's question itself, so it never reached you: one quiet line. */
export function LeadAnsweredLine({ question, hobs }: { question: Question; hobs: HobLookup }) {
  if (question.answeredBy?._tag !== "Lead") return null;
  const lead = hobs(question.answeredBy.agentId);
  const asker = hobs(question.askerId);
  return (
    <p className="ms-9 my-0 flex max-w-work-max animate-hb-in items-start gap-2 text-detail text-secondary-text">
      <HobSprite hob={lead} size={16} />
      <span className="flex flex-col gap-0.5">
        <span className="font-bold text-text">{copy.leadAnswered({ lead: lead.name, asker: asker.name })}</span>
        <span>{question.text}</span>
        <span className="text-mint">{question.answer}</span>
      </span>
    </p>
  );
}
