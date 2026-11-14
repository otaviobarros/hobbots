import type { Agent, Message } from "@hobbots/domain";

/**
 * The hob that wrote a reply (ADR 039, A member hob works as itself): in a camp, a member answers as
 * itself, so its tile and name show on its own replies. A reply saved before authors were recorded,
 * or by a hob no longer listed, shows as the thread's own hob's.
 */
export const replyAuthor = (message: Message, own: Agent, hobs: ReadonlyArray<Agent> | undefined): Agent => {
  const actor = message.actor;
  if (message.role !== "assistant" || actor?.kind !== "hob" || actor.id === own.id) return own;
  return hobs?.find((hob) => hob.id === actor.id) ?? own;
};
