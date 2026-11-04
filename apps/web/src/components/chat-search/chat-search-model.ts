import type { Message, SnippetPart } from "@hobbots/domain";

/** A query shorter than this finds nothing yet, so one letter does not list every message. */
export const MIN_QUERY = 2;

/** How much of a message shows before and after the match. */
const BEFORE = 34;
const AFTER = 60;

/** A message in this chat that says what was searched for, with the match marked. */
export interface ChatHit {
  readonly message: Message;
  readonly parts: ReadonlyArray<SnippetPart>;
}

/**
 * The messages of this chat that contain the query, ignoring case, in the order they were sent: each
 * with a line around its first match, cut with "…" where the message goes on.
 */
export const findInChat = (messages: ReadonlyArray<Message>, query: string): ReadonlyArray<ChatHit> => {
  const wanted = query.trim().toLowerCase();
  if (wanted.length < MIN_QUERY) return [];
  return messages.flatMap((message) => {
    const at = message.content.toLowerCase().indexOf(wanted);
    if (at < 0) return [];
    const text = message.content;
    const start = Math.max(0, at - BEFORE);
    const end = at + wanted.length;
    const stop = Math.min(text.length, end + AFTER);
    const parts: ReadonlyArray<SnippetPart> = [
      { text: `${start > 0 ? "…" : ""}${text.slice(start, at)}`, match: false },
      { text: text.slice(at, end), match: true },
      { text: `${text.slice(end, stop)}${stop < text.length ? "…" : ""}`, match: false },
    ];
    return [{ message, parts: parts.filter((part) => part.text !== "") }];
  });
};
