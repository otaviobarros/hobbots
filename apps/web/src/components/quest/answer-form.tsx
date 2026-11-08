import { type HubQuestion, optionNamed, type Question, type QuestionSurface } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Textarea } from "@hobbots/ui/components/textarea";
import { cn } from "@hobbots/ui/lib/utils";
import { type KeyboardEvent, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { type HubAnswerSent, useAnswerHubQuestion } from "../../api/hub-questions.ts";
import { useAnswerQuestion } from "../../api/questions.ts";
import { firstLine } from "../../lib/format.ts";
import { shownHubQuestion } from "../hub-question/shown.ts";
import { type FocusTargets, NO_TARGETS } from "../move-on/follow-focus.ts";
import { useMoveOn } from "../move-on/move-on.tsx";
import { enterSends } from "./enter-sends.ts";
import { messages } from "./messages.ts";
import { type ChoicesLook, QuestionChoices } from "./question-choices.tsx";

const copy = messages.question;

/** How the answer box looks and where it is: see `AnswerForm`. */
interface FormPlace {
  askerName: string;
  via: QuestionSurface;
  hint?: string;
  route?: string;
  look?: ChoicesLook;
  /** Where focus goes once the answer is sent and the question leaves (#995). */
  targets?: FocusTargets;
  /** False for a question answered by its choices only, with no box (#1241). */
  inWords?: boolean;
}

/**
 * How an answer box sends its answer, whoever asked: whether it is on its way, and why it failed.
 * `picked` is the index of the choice picked, or null for words typed in the box.
 */
interface AnswerSend {
  /** Sends the answer; it resolves once the hub took it. */
  readonly answer: (words: string, picked: number | null) => Promise<unknown>;
  readonly pending: boolean;
  readonly error: string | null;
}

/** An answer mutation as the box sends with it; `closedTag` is the error that says it was already answered. */
const sendOf = <Id, Answer>(
  mutation: {
    readonly mutateAsync: (input: { questionId: Id; answer: Answer }) => Promise<unknown>;
    readonly isPending: boolean;
    readonly error: unknown;
  },
  questionId: Id,
  closedTag: string,
  answerOf: (words: string, picked: number | null) => Answer,
): AnswerSend => ({
  answer: (words, picked) => mutation.mutateAsync({ questionId, answer: answerOf(words, picked) }),
  pending: mutation.isPending,
  error:
    mutation.error === null || mutation.error === undefined
      ? null
      : mutation.error instanceof ApiError && mutation.error.tag === closedTag
        ? copy.closed
        : copy.failed,
});

/**
 * The answer box, wherever a question waits for you; `via` names that place, which your answer
 * records (#671). `route` says where the answer goes, beside Send answer. With `hint`, it is one
 * composer card: the box, then the hint beside Send answer, as in the Inbox. A question with
 * choices (#740) shows them first, as `look` says; a click, or its number key while the form has
 * focus outside the box, answers with that choice, and the box stays for anything else. Once an
 * answer is sent, focus moves to `targets` as the question leaves, and a toast says what was sent.
 */
export function AnswerForm({ question, ...place }: { question: Question } & FormPlace) {
  const send = useAnswerQuestion(place.via);
  // A hob reads a picked choice by its label (#740).
  return (
    <ChoicesForm question={question} send={sendOf(send, question.id, "QuestionClosed", (words) => words)} {...place} />
  );
}

/**
 * The same answer box for a question the hub itself asks you (#976); your answer goes to the hub.
 * The hub reads a choice by its key, never its words (#1045): a picked choice, or words that name
 * one, send its key, and anything else your words.
 */
export function HubAnswerForm({ question, ...place }: { question: HubQuestion } & FormPlace) {
  const send = useAnswerHubQuestion(place.via);
  const shown = shownHubQuestion(question);
  const answerOf = (words: string, picked: number | null): HubAnswerSent => {
    const key = question.options[picked ?? optionNamed(shown.options, words) ?? -1];
    return key === undefined ? { answer: words } : { picked: key };
  };
  return <ChoicesForm question={shown} send={sendOf(send, question.id, "HubQuestionClosed", answerOf)} {...place} />;
}

function ChoicesForm({
  question,
  send,
  askerName,
  hint,
  route,
  look = "rows",
  targets = NO_TARGETS,
  inWords = true,
}: { question: Pick<Question, "options" | "recommended">; send: AnswerSend } & FormPlace) {
  const [answer, setAnswer] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const moveOn = useMoveOn();
  const text = answer.trim();
  const answerWith = (words: string, picked: number | null = null) => {
    if (words === "" || send.pending) return;
    moveOn({
      from: form.current,
      targets,
      sent: send.answer(words, picked),
      say: copy.sent({ name: askerName, answer: firstLine(words) }),
    });
  };
  const submit = () => answerWith(text);
  const choices = question.options.length > 0;
  const composer = hint !== undefined;
  const line = hint ?? route;
  return (
    <form
      ref={form}
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
          disabled={send.pending}
          onPick={answerWith}
          inWords={inWords}
        />
      )}
      {!inWords && send.error !== null && (
        <span role="alert" className="text-ui text-rose">
          {send.error}
        </span>
      )}
      {inWords && (
        <>
          <Textarea
            aria-label={copy.answerLabel({ name: askerName })}
            placeholder={choices ? copy.somethingElse : copy.answerTo({ name: askerName })}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={enterSends(submit)}
            variant={composer ? "bare" : "deep"}
            className={cn(composer ? "min-h-14" : "min-h-10")}
          />
          <SendRow
            line={line}
            composer={composer}
            error={send.error}
            quiet={choices}
            disabled={text === "" || send.pending}
            pending={send.pending}
          />
        </>
      )}
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
  (question: Pick<Question, "options">, answerWith: (words: string, picked: number) => void) =>
  (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.target instanceof HTMLTextAreaElement || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(event.key) - 1;
    const option = question.options[index];
    if (option === undefined) return;
    event.preventDefault();
    answerWith(option.label, index);
  };
