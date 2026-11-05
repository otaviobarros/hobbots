import type { Question, QuestionSurface, TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { cn } from "@hobbots/ui/lib/utils";
import { type KeyboardEvent, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useAnswerQuestion } from "../../api/questions.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { enterSends } from "./enter-sends.ts";
import { messages } from "./messages.ts";
import { AnsweredChoices, type ChoicesLook, QuestionChoices } from "./question-choices.tsx";
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

/**
 * The answer box, wherever a question waits for you; `via` names that place, which your answer
 * records (#671). `route` says where the answer goes, beside Send answer. With `hint`, it is one
 * composer card: the box, then the hint beside Send answer, as in the Inbox. A question with
 * choices (#740) shows them first, as `look` says; a click, or its number key while the form has
 * focus outside the box, answers with that choice, and the box stays for anything else.
 */
export function AnswerForm({
  question,
  askerName,
  via,
  hint,
  route,
  look = "rows",
}: {
  question: Question;
  askerName: string;
  via: QuestionSurface;
  hint?: string;
  route?: string;
  look?: ChoicesLook;
}) {
  const [answer, setAnswer] = useState("");
  const send = useAnswerQuestion(via);
  const text = answer.trim();
  const answerWith = (words: string) => {
    if (words === "" || send.isPending) return;
    send.mutate({ questionId: question.id, answer: words });
  };
  const submit = () => answerWith(text);
  const choices = question.options.length > 0;
  const closed = send.error instanceof ApiError && send.error.tag === "QuestionClosed";
  const composer = hint !== undefined;
  const line = hint ?? route;
  return (
    <form
      className={cn(
        "flex flex-col",
        composer ? "gap-2.5 rounded-card border-(length:--edge) border-control bg-card p-3" : "gap-2",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={choiceKeys(question, answerWith)}
    >
      {choices && (
        <QuestionChoices
          question={question}
          askerName={askerName}
          look={look}
          disabled={send.isPending}
          onPick={answerWith}
        />
      )}
      <Textarea
        aria-label={copy.answerLabel({ name: askerName })}
        placeholder={choices ? copy.somethingElse : copy.answerTo({ name: askerName })}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={enterSends(submit)}
        variant={composer ? "bare" : "deep"}
        className={composer ? "min-h-14" : "min-h-10"}
      />
      <SendRow
        line={line}
        composer={composer}
        error={send.isError ? (closed ? copy.closed : copy.failed) : null}
        quiet={choices}
        disabled={text === "" || send.isPending}
        pending={send.isPending}
      />
    </form>
  );
}

/**
 * Where the answer goes, any error, and Send answer. With `quiet`, the box is for anything other
 * than the question's choices, so Send answer steps back to an outline (#740).
 */
function SendRow({
  line,
  composer,
  error,
  quiet,
  disabled,
  pending,
}: {
  line: string | undefined;
  composer: boolean;
  error: string | null;
  quiet: boolean;
  disabled: boolean;
  pending: boolean;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {line !== undefined && <span className="min-w-0 flex-1 text-meta text-label">{line}</span>}
      {error !== null && (
        <span role="alert" className={cn("text-ui text-rose", !composer && "order-last")}>
          {error}
        </span>
      )}
      <Button
        type="submit"
        variant={quiet ? "outline" : "default"}
        size={line === undefined ? "sm" : "default"}
        disabled={disabled}
      >
        {pending ? copy.sending : copy.send}
      </Button>
    </span>
  );
}

/** A choice's number key, pressed in the answer form outside its box, answers with that choice (#740). */
const choiceKeys =
  (question: Question, answerWith: (words: string) => void) => (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.target instanceof HTMLTextAreaElement || event.altKey || event.ctrlKey || event.metaKey) return;
    const option = question.options[Number(event.key) - 1];
    if (option === undefined) return;
    event.preventDefault();
    answerWith(option.label);
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
