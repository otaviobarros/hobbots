import { ChannelId, Message, MessageId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ChannelArchived, ChannelNotFound, MessageKeyReused, MessageNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * A reply in a thread (ADR 039, Reply threads); `key` becomes its id, so the same reply sent again is
 * written once. `alsoInMainLine` sends it to the channel's main line too.
 */
export const ReplyInThreadPayload = Schema.Struct({
  key: MessageId,
  content: Schema.NonEmptyString,
  alsoInMainLine: Schema.Boolean,
});
export type ReplyInThreadPayload = typeof ReplyInThreadPayload.Type;

/** Reply threads: any main-line message of a chat or camp can have one, as in Slack. */
export class ThreadsGroup extends HttpApiGroup.make("threads")
  .add(
    // A thread's replies come with the channel's messages, each naming its root.
    HttpApiEndpoint.post("replyInThread", "/channels/:channelId/messages/:messageId/replies", {
      params: { channelId: ChannelId, messageId: MessageId },
      payload: ReplyInThreadPayload,
      success: Message,
      error: [ChannelNotFound, ChannelArchived, MessageNotFound, MessageKeyReused],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
