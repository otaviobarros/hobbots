import { Schema } from "effect";
import { ConfigVersion } from "./agent.ts";
import { MessageId, ThreadId } from "./ids.ts";

export const MessageRole = Schema.Literals(["user", "assistant"]);
export type MessageRole = typeof MessageRole.Type;

export const MessageStatus = Schema.Literals(["streaming", "complete", "failed", "interrupted"]);
export type MessageStatus = typeof MessageStatus.Type;

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

const requireStreaming = (message: Message, action: string) =>
  message.status === "streaming"
    ? undefined
    : new InvalidMessageTransition({
        messageId: message.id,
        from: message.status,
        action,
      });

/** Pure transitions for an assistant message. Only a streaming message can change. */
export const MessageTransitions = {
  appendDelta: (message: Message, delta: string): Message | InvalidMessageTransition =>
    requireStreaming(message, "appendDelta") ?? new Message({ ...message, content: message.content + delta }),

  complete: (message: Message, finalContent?: string): Message | InvalidMessageTransition =>
    requireStreaming(message, "complete") ??
    new Message({
      ...message,
      content: finalContent ?? message.content,
      status: "complete",
    }),

  fail: (message: Message, error: string): Message | InvalidMessageTransition =>
    requireStreaming(message, "fail") ?? new Message({ ...message, status: "failed", error }),

  interrupt: (message: Message): Message | InvalidMessageTransition =>
    requireStreaming(message, "interrupt") ?? new Message({ ...message, status: "interrupted" }),
};
