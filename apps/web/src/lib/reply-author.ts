import { type Agent, type Message, replyHobOf } from "@hobbots/domain";

/**
 * The hob that wrote a reply (ADR 039, A member hob works as itself): in a camp, a member answers as
 * itself, so its tile and name show on its own replies. Its author is the message's own, through
 * `replyHobOf`; a hob no longer listed shows as the thread's own hob, `own`.
 */
export const replyAuthor = (message: Message, own: Agent, hobs: ReadonlyArray<Agent> | undefined): Agent => {
  const writer = replyHobOf(message, { agentId: own.id });
  if (writer === null || writer === own.id) return own;
  return hobs?.find((hob) => hob.id === writer) ?? own;
};
