import { MessageId } from "@hobbots/domain";
import { readStored, removeStored, writeStored } from "../../lib/storage.ts";

/**
 * The reply a thread's box last sent and has no answer for yet, kept outside the box as its draft is
 * (ADR 016): sending the same reply again, even after the thread was closed or the page reloaded,
 * reuses its key, so the hub writes it once.
 */
interface PendingReply {
  readonly key: string;
  readonly content: string;
  readonly alsoInMainLine: boolean;
}

const storageKey = (rootId: MessageId) => `thread-reply.${rootId}`;
// Held in memory too, so it outlives the box where browser storage is unavailable.
const pending = new Map<MessageId, PendingReply>();

const isPending = (value: unknown): value is PendingReply =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PendingReply).key === "string" &&
  typeof (value as PendingReply).content === "string" &&
  typeof (value as PendingReply).alsoInMainLine === "boolean";

/** The key to send `reply` under: the pending one's when it is the same reply, else a new one, kept. */
export const replyKey = (rootId: MessageId, reply: Omit<PendingReply, "key">): MessageId => {
  const stored = pending.get(rootId) ?? readStored<unknown>(storageKey(rootId), null);
  if (isPending(stored) && stored.content === reply.content && stored.alsoInMainLine === reply.alsoInMainLine) {
    return MessageId.make(stored.key);
  }
  const key = MessageId.make(crypto.randomUUID());
  pending.set(rootId, { ...reply, key });
  writeStored(storageKey(rootId), { ...reply, key });
  return key;
};

/** The pending reply is settled: written, or refused so that sending again makes a new one. */
export const settleReply = (rootId: MessageId) => {
  pending.delete(rootId);
  removeStored(storageKey(rootId));
};
