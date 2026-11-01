/**
 * What the main process takes from the hub's event stream (ADR 013): when it connected, and which
 * of its own reads a change makes stale. It reads the stream instead of polling, so an idle app
 * sends no requests.
 */
import { Option, Schema } from "effect";
import type { Event } from "effect/encoding/Sse";

/** A read the main process makes again: the Inbox's requests, or which hobs are working. */
export type HubChange = "approvals" | "activity";

/** The part of a journal entry the main process reads; the rest of the envelope is ignored. */
const HubEntry = Schema.Struct({
  type: Schema.String,
  payload: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.Struct({ role: Schema.String })) })),
});
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(HubEntry));

/**
 * What a frame means for the main process: `connected` for the stream's first frame, the read a
 * journal entry makes stale, or null when it changes nothing the main process shows. A hob starts
 * and ends its turns through its reply, so only a reply's upsert changes who is working.
 */
export const frameChange = (frame: Pick<Event, "event" | "data">): HubChange | "connected" | null => {
  if (frame.event === "ready") return "connected";
  if (frame.event !== "message") return null;
  const entry = Option.getOrUndefined(decodeEntry(frame.data));
  switch (entry?.type) {
    case "ApprovalRequested":
    case "ApprovalResolved":
      return "approvals";
    case "MessageUpserted":
      return entry.payload?.message?.role === "assistant" ? "activity" : null;
    default:
      return null;
  }
};
