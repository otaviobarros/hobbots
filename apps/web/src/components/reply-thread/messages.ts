import { formatCount, plural } from "../../lib/format.ts";

/** User-facing copy for reply threads (ADR 039, Reply threads; STD-I18N-001). */
export const messages = {
  /** The root's one line: how many replies, and when the last one came. */
  replies: ({ count }: { readonly count: number }) =>
    plural(count, { one: "1 reply", other: `${formatCount(count)} replies` }),
  lastReply: ({ time }: { readonly time: string }) => `Last reply ${time}`,
  view: "View thread ›",
  /** The thread beside the chat. */
  title: "Thread",
  close: "Close the thread",
  landmark: "Thread",
  noReplies: "No replies yet",
  placeholder: "Reply in thread",
  alsoSend: {
    camp: "Also send to the camp",
    chat: "Also send to the chat",
  },
  alsoSent: {
    camp: ({ title }: { readonly title: string }) => `Also sent to ${title}`,
    chat: "Also sent to the chat",
  },
  noHobAnswers: "No hob will answer",
  send: "Send",
  sending: "Sending…",
  failed: "Couldn't send the reply. Your text is still in the box; try again in a moment.",
  gone: "This thread's message is no longer here.",
  you: "You",
  /** On a reply also sent to the main line, which opens its thread. */
  fromThread: "From a thread",
};
