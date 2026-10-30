import { Schema } from "effect";
import { ConfigVersion } from "./agent.ts";
import { MessageId, ThreadId } from "./ids.ts";

export const MessageRole = Schema.Literals(["user", "assistant"]);
export type MessageRole = typeof MessageRole.Type;

/**
 * - `queued`: a user message waiting for the thread's current turn to end.
 * - `streaming`: the hob is writing this reply.
 * - `stopping`: the user asked to stop; the reply still counts as in progress until the runtime confirms.
 * - `stopped`: the runtime confirmed the turn ended after a stop request; the partial text is kept.
 * - `interrupted`: Hobbots ended the turn itself (a restart, pause or retirement), not the user.
 */
export const MessageStatus = Schema.Literals([
  "queued",
  "streaming",
  "stopping",
  "complete",
  "failed",
  "stopped",
  "interrupted",
]);
export type MessageStatus = typeof MessageStatus.Type;

/** A reply whose turn has not ended yet, so its thread is busy. */
export const isInProgress = (status: MessageStatus): boolean => status === "streaming" || status === "stopping";

export class Message extends Schema.Class<Message>("Message")({
  id: MessageId,
  threadId: ThreadId,
  role: MessageRole,
  content: Schema.String,
  status: MessageStatus,
  error: Schema.NullOr(Schema.String),
  /** For an assistant message, the hob configuration version that produced it; null for the user's. */
  configVersion: Schema.NullOr(ConfigVersion),
  createdAt: Schema.String,
}) {}

export class InvalidMessageTransition extends Schema.TaggedError<InvalidMessageTransition>()(
  "InvalidMessageTransition",
  { messageId: MessageId, from: MessageStatus, action: Schema.String },
) {}

const requireInProgress = (message: Message, action: string) =>
  isInProgress(message.status)
    ? undefined
    : new InvalidMessageTransition({
        messageId: message.id,
        from: message.status,
        action,
      });

/**
 * Pure transitions for an assistant message. Only a reply in progress can change; a stop request
 * does not end the turn, so a stopping reply still takes text and may still complete or fail.
 */
export const MessageTransitions = {
  appendDelta: (message: Message, delta: string): Message | InvalidMessageTransition =>
    requireInProgress(message, "appendDelta") ?? new Message({ ...message, content: message.content + delta }),

  complete: (message: Message, finalContent?: string): Message | InvalidMessageTransition =>
    requireInProgress(message, "complete") ??
    new Message({
      ...message,
      content: finalContent ?? message.content,
      status: "complete",
    }),

  fail: (message: Message, error: string): Message | InvalidMessageTransition =>
    requireInProgress(message, "fail") ?? new Message({ ...message, status: "failed", error }),

  /** Records the user's stop request. Asking again while stopping changes nothing. */
  requestStop: (message: Message): Message | InvalidMessageTransition =>
    requireInProgress(message, "requestStop") ?? new Message({ ...message, status: "stopping" }),

  /** The turn ended: stopped when the user asked for it, otherwise interrupted by Hobbots. */
  interrupt: (message: Message): Message | InvalidMessageTransition =>
    requireInProgress(message, "interrupt") ??
    new Message({ ...message, status: message.status === "stopping" ? "stopped" : "interrupted" }),
};
