import { CatchUp, Message, MessageId, MessagePin, NOTE_TEXT_MAX, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { MessageKeyReused, MessageNotFound, ThreadArchived, ThreadNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/** A note to self (ADR 037); `key` becomes its id, so the same note sent again is written once. */
export const WriteNotePayload = Schema.Struct({
  key: MessageId,
  content: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(NOTE_TEXT_MAX)),
});
export type WriteNotePayload = typeof WriteNotePayload.Type;

export const PinMessagePayload = Schema.Struct({ pinned: Schema.Boolean });

/**
 * What is yours in a chat or camp (ADR 037, Mine): notes to self, which no hob reads, and the
 * messages you pinned; and catch-up, what changed there since you last read it.
 */
export class NotesGroup extends HttpApiGroup.make("notes")
  .add(
    HttpApiEndpoint.post("writeNote", "/threads/:threadId/notes", {
      params: { threadId: ThreadId },
      payload: WriteNotePayload,
      success: Message,
      error: [ThreadNotFound, ThreadArchived, MessageKeyReused],
    }),
    // The newest pin first.
    HttpApiEndpoint.get("pins", "/threads/:threadId/pins", {
      params: { threadId: ThreadId },
      success: Schema.Array(MessagePin),
      error: ThreadNotFound,
    }),
    // Pinning a pinned message, or unpinning one that is not, answers as it stands; null once unpinned.
    HttpApiEndpoint.put("pinMessage", "/threads/:threadId/messages/:messageId/pinned", {
      params: { threadId: ThreadId, messageId: MessageId },
      payload: PinMessagePayload,
      success: Schema.NullOr(MessagePin),
      error: [ThreadNotFound, MessageNotFound],
    }),
    // Read it before marking the thread read, which moves the marker it is measured from.
    HttpApiEndpoint.get("catchUp", "/threads/:threadId/catch-up", {
      params: { threadId: ThreadId },
      success: CatchUp,
      error: ThreadNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
