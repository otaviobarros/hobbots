import type { Question } from "@hobbots/domain";
import { formatWhen } from "../../lib/time.ts";
import { AnswerForm, answerRoute } from "../quest/question-card.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { messages } from "./messages.ts";

/**
 * A question for you, lit in lantern in the lane of the hob that asked (ADR 027). It is the same
 * question as in the chat, the Needs-you tray and the Inbox, so answering here answers it there.
 * Your answer goes back down the leads that passed it up. A lane is narrow, so a question's choices
 * show as chips (#740), above the box for an answer in words.
 */
export function LaneAsk({ question, hobs }: { question: Question; hobs: HobLookup }) {
  const asker = hobs(question.askerId).name;
  const chain = [asker, ...question.chain.map((id) => hobs(id).name)];
  return (
    <section
      aria-label={messages.asks({ name: asker })}
      className="flex flex-col gap-2 rounded-control border-(length:--edge) border-solid border-lantern bg-[color-mix(in_srgb,var(--color-lantern)_12%,var(--color-card))] p-2.5"
    >
      <span className="text-meta font-bold text-lantern">
        <span aria-hidden>{messages.asksMark} </span>
        {messages.asks({ name: asker })}
      </span>
      <p className="m-0 text-ui whitespace-pre-wrap text-text-strong">{question.text}</p>
      <p className="m-0 text-meta text-label">{messages.passedUp({ chain, when: formatWhen(question.createdAt) })}</p>
      <AnswerForm question={question} askerName={asker} via="task" route={answerRoute(question, hobs)} look="chips" />
    </section>
  );
}
