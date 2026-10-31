import { Effect, Schema } from "effect";
import { ConfigVersion } from "./agent.ts";
import { MessageId, ThreadId } from "./ids.ts";
import { Revision } from "./revision.ts";

export const MessageRole = Schema.Literals(["user", "assistant"]);
export type MessageRole = typeof MessageRole.Type;

/**
 * - `queued`: a user message waiting for the thread's current turn to end.
 * - `streaming`: the hob is writing this reply.
 * - `stopping`: the user asked to stop; the reply still counts as in progress until the runtime confirms.
 * - `stopped`: the runtime confirmed the turn ended after a stop request; the partial text is kept.
 * - `interrupted`: the reply was cut off, not by the user: Hobbots ended the turn (a restart, pause or
 *   retirement), or the runtime stopped after it had started writing (`error` says why). Continue resumes it.
 * - `limited`: the provider's usage limit ended the turn; `resetsAt` says when it refills, if known.
 */
export const MessageStatus = Schema.Literals([
  "queued",
  "streaming",
  "stopping",
  "complete",
  "failed",
  "stopped",
  "interrupted",
  "limited",
]);
export type MessageStatus = typeof MessageStatus.Type;

/** A reply whose turn has not ended yet, so its thread is busy. */
export const isInProgress = (status: MessageStatus): boolean => status === "streaming" || status === "stopping";

/** A reply that ended early and that Continue can resume in place. */
export const isResumable = (status: MessageStatus): boolean => status === "interrupted" || status === "limited";

export class Message extends Schema.Class<Message>("Message")({
  id: MessageId,
  threadId: ThreadId,
  role: MessageRole,
  content: Schema.String,
  status: MessageStatus,
  error: Schema.NullOr(Schema.String),
  /** For an assistant message, the hob configuration version that produced it; null for the user's. */
  configVersion: Schema.NullOr(ConfigVersion),
  /** For a `limited` reply, when the provider's allowance refills (ISO 8601), if it said. */
  resetsAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  createdAt: Schema.String,
  revision: Revision,
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

  /**
   * The runtime failed. A reply that had started writing was cut off, so it keeps its text and can
   * be continued; one that had written nothing failed.
   */
  cutOff: (message: Message, error: string): Message | InvalidMessageTransition =>
    requireInProgress(message, "cutOff") ??
    new Message({ ...message, status: message.content.length > 0 ? "interrupted" : "failed", error }),

  /** The provider's usage limit ended the turn; the text so far is kept. */
  limit: (message: Message, resetsAt: string | null): Message | InvalidMessageTransition =>
    requireInProgress(message, "limit") ?? new Message({ ...message, status: "limited", error: null, resetsAt }),

  /** Continue: a reply that ended early streams again, appending to the text it kept. */
  resume: (message: Message): Message | InvalidMessageTransition =>
    message.role === "assistant" && isResumable(message.status)
      ? new Message({ ...message, status: "streaming", error: null, resetsAt: null })
      : new InvalidMessageTransition({ messageId: message.id, from: message.status, action: "resume" }),

  /** Records the user's stop request. Asking again while stopping changes nothing. */
  requestStop: (message: Message): Message | InvalidMessageTransition =>
    requireInProgress(message, "requestStop") ?? new Message({ ...message, status: "stopping" }),

  /** The turn ended: stopped when the user asked for it, otherwise interrupted by Hobbots. */
  interrupt: (message: Message): Message | InvalidMessageTransition =>
    requireInProgress(message, "interrupt") ??
    new Message({ ...message, status: message.status === "stopping" ? "stopped" : "interrupted" }),
};

/** Pure transitions for a user message waiting in its thread's queue (CH-008). */
export const QueuedMessageTransitions = {
  /** The message's turn starts: it leaves the queue and joins the transcript. */
  start: (message: Message): Message | InvalidMessageTransition =>
    message.role === "user" && message.status === "queued"
      ? new Message({ ...message, status: "complete" })
      : new InvalidMessageTransition({ messageId: message.id, from: message.status, action: "start" }),
};
