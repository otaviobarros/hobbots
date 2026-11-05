import type { ApprovalSurface, HubQuestion } from "@hobbots/domain";
import { formatWhen } from "../../lib/time.ts";
import { messages as inboxCopy } from "../inbox/messages.ts";
import { HubAnswerForm } from "../quest/answer-form.tsx";
import { Details } from "./details.tsx";
import { messages } from "./messages.ts";

/** A question the hub itself asks you, in the tray (#976): the same card, answered for the hub. */
export function HubQuestionBody({ question, via }: { question: HubQuestion; via: ApprovalSurface }) {
  return (
    <>
      <p className="m-0 whitespace-pre-wrap text-text">{question.text}</p>
      <HubAnswerForm question={question} askerName={inboxCopy.row.hubInSentence} via={via} />
      <Details summary={messages.details.question}>
        {messages.fromHub({ about: question.subject.title, when: formatWhen(question.createdAt) })}
      </Details>
    </>
  );
}
