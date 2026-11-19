import { MessageId } from "@hobbots/domain";
import { Schema } from "effect";
import { readStored, removeStored, writeStored } from "../../lib/storage.ts";

/**
 * The reply a thread's box last sent and has no answer for yet, kept outside the box as its draft is
 * (ADR 016): sending the same reply again, even after the thread was closed or the page reloaded,
 * reuses its key, so the hub writes it once. Stored versioned and parsed when read (STD-REACT-026):
 * a record in any other shape is dropped, so the next send makes a new key.
 */
const PendingReply = Schema.Struct({
  v: Schema.Literal(1),
  key: MessageId,
  content: Schema.String,
  alsoInMainLine: Schema.Boolean,
});
type PendingReply = typeof PendingReply.Type;

const isPending = Schema.is(PendingReply);

const storageKey = (rootId: MessageId) => `thread-reply.${rootId}`;
// Held in memory too, so it outlives the box where browser storage is unavailable.
const pending = new Map<MessageId, PendingReply>();

const pendingFor = (rootId: MessageId): PendingReply | undefined => {
  const known = pending.get(rootId);
  if (known !== undefined) return known;
  const stored = readStored<unknown>(storageKey(rootId), null);
  if (isPending(stored)) return stored;
  if (stored !== null) removeStored(storageKey(rootId));
  return undefined;
};

/** The key to send a reply under: the pending one's when it is the same reply, else a new one, kept. */
export const replyKey = (
  rootId: MessageId,
  reply: { readonly content: string; readonly alsoInMainLine: boolean },
): MessageId => {
  const known = pendingFor(rootId);
  if (known !== undefined && known.content === reply.content && known.alsoInMainLine === reply.alsoInMainLine) {
    return known.key;
  }
  const kept: PendingReply = { v: 1, key: MessageId.make(crypto.randomUUID()), ...reply };
  pending.set(rootId, kept);
  writeStored(storageKey(rootId), kept);
  return kept.key;
};

/** The pending reply is settled: written, or refused so that sending again makes a new one. */
export const settleReply = (rootId: MessageId) => {
  pending.delete(rootId);
  removeStored(storageKey(rootId));
};
