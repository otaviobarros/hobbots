import type { WaitingQuestion } from "@hobbots/api";
import { Badge } from "@hobbots/ui/components/badge";
import { Link } from "@tanstack/react-router";
import { formatWhen } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { AnswerForm } from "../quest/question-card.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages.question;

/**
 * A question that climbed every lead and reached you (ADR 018), in Needs you: who asked, about
 * which Task, which leads passed it up, and the answer box the card in the chat has. Your answer
 * goes back down the same chain to the hob that asked. The chat it opens is the top lead's, the
 * last to pass it up, or the asker's own when nobody leads it.
 */
export function QuestionForYou({ waiting, hobs }: { waiting: WaitingQuestion; hobs: HobLookup }) {
  const { question, task } = waiting;
  const asker = hobs(question.askerId);
  const chatHob = question.chain.at(-1) ?? question.askerId;
  const passedBy = question.chain.map((agentId) => hobs(agentId).name);
  return (
    <section
      aria-label={copy.label({ name: asker.name })}
      className="cut flex flex-col gap-2 border-2 border-lantern bg-card px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <HobSprite hob={asker} size={20} state="needs-you" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-bold">{copy.title({ name: asker.name })}</span>
          <span className="truncate text-detail text-secondary-text">
            {copy.about({ title: taskTitle(task), when: formatWhen(question.createdAt) })}
          </span>
        </span>
        <Badge variant="needs-you">{copy.badge}</Badge>
      </div>
      <p className="m-0 leading-normal whitespace-pre-wrap">{question.text}</p>
      {passedBy.length > 0 && <p className="m-0 text-xs text-label">{copy.passedBy({ names: passedBy })}</p>}
      <AnswerForm question={question} askerName={asker.name} />
      {task.threadId !== null && (
        <Link
          to="/hobs/$hobId/threads/$threadId"
          params={{ hobId: chatHob, threadId: task.threadId }}
          className="self-end text-detail"
        >
          {copy.openChat({ name: hobs(chatHob).name })}
        </Link>
      )}
    </section>
  );
}
