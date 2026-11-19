import { type Actor, inMainLine, type Message, type MessageId } from "@hobbots/domain";

/**
 * Reply threads as the chat lays them out (ADR 039, Reply threads): the main line, and each root's
 * replies. Each reply names its root, so this only groups the channel's messages the hub sent; it
 * decides nothing about them.
 */

/** What a root shows of its thread in one line: who replied, how many replies, and the last one's time. */
export interface ThreadLine {
  /** Who replied, each once, the latest first. */
  readonly repliers: ReadonlyArray<Actor>;
  readonly count: number;
  readonly lastAt: string;
}

/** The messages the main line shows: those with no root, and replies also sent there. */
const mainLineOf = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => messages.filter(inMainLine);

/** The replies in the thread of `rootId`, in the order they were sent. */
export const repliesIn = (messages: ReadonlyArray<Message>, rootId: MessageId): ReadonlyArray<Message> =>
  messages.filter((message) => message.rootMessageId === rootId && message.status !== "queued");

const sameActor = (a: Actor, b: Actor) => a.kind === b.kind && a.id === b.id;

/** Each root's thread line, keyed by the root's id; a message with no replies has none. */
export const threadLines = (messages: ReadonlyArray<Message>): ReadonlyMap<MessageId, ThreadLine> => {
  const lines = new Map<MessageId, ThreadLine>();
  for (const message of messages) {
    const root = message.rootMessageId;
    if (root === null || message.status === "queued") continue;
    const line = lines.get(root);
    const earlier = (line?.repliers ?? []).filter(
      (actor) => message.actor === null || !sameActor(actor, message.actor),
    );
    lines.set(root, {
      repliers: message.actor === null ? earlier : [message.actor, ...earlier],
      count: (line?.count ?? 0) + 1,
      lastAt: message.createdAt,
    });
  }
  return lines;
};

/**
 * The chat's said messages, every one but those still waiting their turn, and its main line, which
 * leaves out replies only in a thread. Both are undefined until the channel's messages are read.
 */
export const chatLines = (
  messages: ReadonlyArray<Message> | undefined,
): { readonly said: ReadonlyArray<Message> | undefined; readonly transcript: ReadonlyArray<Message> | undefined } => {
  if (messages === undefined) return { said: undefined, transcript: undefined };
  const said = messages.filter((message) => message.status !== "queued");
  return { said, transcript: mainLineOf(said) };
};
