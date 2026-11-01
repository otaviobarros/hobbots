/**
 * What the main process takes from the hub's event stream (ADR 013): when it connected, whether it
 * resumed, and which
 * of its own reads a change makes stale. It reads the stream instead of polling, so an idle app
 * sends no requests.
 */
import { STREAM_FRAME } from "@hobbots/domain";
import { Option, Schema } from "effect";
import type { Event } from "effect/encoding/Sse";

/**
 * A change the main process reads again: the Inbox's requests, or which hobs are working, once a
 * turn joined or left the hub's running turns.
 */
export type HubChange = { readonly _tag: "Approvals" } | { readonly _tag: "Activity" };

/** The part of a journal entry the main process reads; the rest of the envelope is ignored. */
const HubEntry = Schema.Struct({ type: Schema.String });
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(HubEntry));
const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ resumed: Schema.Boolean })));

/**
 * The stream connected. `resumed` is true when the hub replays every entry after the cursor the
 * main process sent, so nothing was missed while it was away (ADR 013).
 */
export interface HubConnected {
  readonly _tag: "Connected";
  readonly resumed: boolean;
}

/**
 * What a frame means for the main process: `Connected` for the stream's first frame, the read a
 * frame makes stale, or null when it changes nothing the main process shows. The hub announces each
 * turn that joins or leaves its running turns with a `turn` frame, sent once `/api/activity` already
 * reports the change, so one read on it is enough.
 */
export const frameChange = (frame: Pick<Event, "event" | "data">): HubChange | HubConnected | null => {
  switch (frame.event) {
    case STREAM_FRAME.ready:
      return { _tag: "Connected", resumed: Option.getOrUndefined(decodeReady(frame.data))?.resumed === true };
    case STREAM_FRAME.turn:
      return { _tag: "Activity" };
    case "message":
      switch (Option.getOrUndefined(decodeEntry(frame.data))?.type) {
        case "ApprovalRequested":
        case "ApprovalResolved":
          return { _tag: "Approvals" };
        default:
          return null;
      }
    default:
      return null;
  }
};
