import type { ApprovalSurface, HubQuestion } from "@hobbots/domain";
import { formatWhen } from "../../lib/time.ts";
import { HubQuestionAnswer } from "../coding-setup/coding-setup.tsx";
import { shownHubQuestion } from "../hub-question/shown.ts";
import { messages as inboxCopy } from "../inbox/messages.ts";
import { Details } from "./details.tsx";
import { messages } from "./messages.ts";
import { trayTargets } from "./tray-focus.ts";

/** A question the hub itself asks you, in the tray (#976): the same card, answered for the hub. */
export function HubQuestionBody({ question, via }: { question: HubQuestion; via: ApprovalSurface }) {
  const shown = shownHubQuestion(question);
  return (
    <>
      <p className="m-0 whitespace-pre-wrap text-text">{shown.text}</p>
      <HubQuestionAnswer question={question} askerName={inboxCopy.row.hubInSentence} via={via} targets={trayTargets} />
      <Details summary={messages.details.question}>
        {messages.fromHub({ about: shown.title, when: formatWhen(question.createdAt) })}
      </Details>
    </>
  );
}
