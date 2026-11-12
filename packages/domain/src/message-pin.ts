import { Schema } from "effect";
import { MessageId, ThreadId } from "./ids.ts";
import { Revision } from "./revision.ts";

/**
 * A message you pinned in a chat or camp (ADR 037, Mine): it shows under Mine in the camp's sheet
 * until you unpin it. A pin is a setting, as a thread's is: it changes nothing about the message, so
 * the message keeps its revision and pinning a reply never leaves its thread unread. It follows its
 * message, so a chapter moved into a camp takes its pins along.
 */
export class MessagePin extends Schema.Class<MessagePin>("MessagePin")({
  messageId: MessageId,
  /** The chat or camp the message is in now. */
  threadId: ThreadId,
  pinnedAt: Schema.String,
  /** The journal sequence of the `MessagePinned` that wrote it. */
  revision: Revision,
}) {}
