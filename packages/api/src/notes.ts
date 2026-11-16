import { CatchUp, ChannelId, Message, MessageId, MessagePin, NOTE_TEXT_MAX } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ChannelArchived, ChannelNotFound, MessageKeyReused, MessageNotFound } from "./errors.ts";
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
    HttpApiEndpoint.post("writeNote", "/channels/:channelId/notes", {
      params: { channelId: ChannelId },
      payload: WriteNotePayload,
      success: Message,
      error: [ChannelNotFound, ChannelArchived, MessageKeyReused],
    }),
    // The newest pin first.
    HttpApiEndpoint.get("pins", "/channels/:channelId/pins", {
      params: { channelId: ChannelId },
      success: Schema.Array(MessagePin),
      error: ChannelNotFound,
    }),
    // Pinning a pinned message, or unpinning one that is not, answers as it stands; null once unpinned.
    HttpApiEndpoint.put("pinMessage", "/channels/:channelId/messages/:messageId/pinned", {
      params: { channelId: ChannelId, messageId: MessageId },
      payload: PinMessagePayload,
      success: Schema.NullOr(MessagePin),
      error: [ChannelNotFound, MessageNotFound],
    }),
    // Read it before marking the channel read, which moves the marker it is measured from.
    HttpApiEndpoint.get("catchUp", "/channels/:channelId/catch-up", {
      params: { channelId: ChannelId },
      success: CatchUp,
      error: ChannelNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
