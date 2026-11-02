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
 * turn joined or left the hub's running turns. `RemoteAccess`: remote access changed, such as the
 * hub moving to another port or being paused (ADR 021).
 */
export type HubChange =
  | { readonly _tag: "Approvals" }
  | { readonly _tag: "Activity" }
  | ({ readonly _tag: "RemoteAccess" } & RemoteAccessView);

/** The part of the hub's remote access the main process uses: its port, and whether it is on and paused. */
export interface RemoteAccessView {
  readonly port: number;
  readonly enabled: boolean;
  readonly paused: boolean;
}

/** The fields of a remote access status the main process reads. */
export const RemoteAccessView = Schema.Struct({ port: Schema.Int, enabled: Schema.Boolean, paused: Schema.Boolean });

/** The part of a journal entry the main process reads; the rest of the envelope is ignored. */
const HubEntry = Schema.Struct({ type: Schema.String });
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(HubEntry));
const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ resumed: Schema.Boolean })));
const decodeRemoteAccess = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ status: RemoteAccessView })),
);

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
    case STREAM_FRAME.remoteAccess:
      return Option.match(decodeRemoteAccess(frame.data), {
        onNone: () => null,
        onSome: ({ status }) => ({ _tag: "RemoteAccess", ...status }),
      });
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
