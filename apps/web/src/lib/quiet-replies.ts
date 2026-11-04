import type { Message } from "@hobbots/domain";

/**
 * Whether the chat leaves a reply out (#901): a lead woken by work that arrived for it, not by your
 * message, that acted and wrote nothing, as it is told to between the plan and the finish. A reply
 * to your message always shows, and so does one that ended early, which you may need to continue.
 */
export const isQuietReply = (message: Message, before: Message | undefined): boolean =>
  message.role === "assistant" &&
  message.status === "complete" &&
  message.content.trim() === "" &&
  before !== undefined &&
  before.role === "assistant";
