/**
 * What the main process takes from the hub's event stream (ADR 013): when it connected, whether it
 * resumed, and which
 * of its own reads a change makes stale. It reads the stream instead of polling, so an idle app
 * sends no requests.
 */
import { STREAM_FRAME } from "@hobbots/domain";
import { Option, Schema } from "effect";
import type { Event } from "effect/encoding/Sse";
import { type FinishedQuest, finishedQuest } from "./request-notices-model.ts";

/**
 * A change the main process reads again: the Inbox's requests, or which hobs are working, once a
 * turn joined or left the hub's running turns. `RemoteAccess`: remote access changed, such as the
 * hub moving to another port or being paused (ADR 021).
 */
export type HubChange =
  | { readonly _tag: "Approvals" }
  | { readonly _tag: "Pairing" }
  | { readonly _tag: "Activity" }
  /** A question reached you, moved or was answered or withdrawn (ADR 027). */
  | { readonly _tag: "Questions" }
  /** A Task changed state, so the failed Tasks that wait on you may have changed (ADR 027). */
  | { readonly _tag: "Tasks" }
  /** A top Quest finished (ADR 027). */
  | { readonly _tag: "QuestFinished"; readonly quest: FinishedQuest }
  | ({
      readonly _tag: "RemoteAccess";
      /**
       * Whether the hub's HTTPS address answers: HTTPS is on, its listener is open and Tailscale
       * forwards to it. Null from a hub whose event does not say.
       */
      readonly servesHttps: boolean | null;
    } & RemoteAccessView);

/** The part of the hub's remote access the main process uses: its port, and whether it is on and paused. */
export const RemoteAccessView = Schema.Struct({ port: Schema.Int, enabled: Schema.Boolean, paused: Schema.Boolean });
export type RemoteAccessView = typeof RemoteAccessView.Type;

/** The part of a journal entry the main process reads; the rest of the envelope is ignored. */
const HubEntry = Schema.Struct({ type: Schema.String, payload: Schema.optionalKey(Schema.Unknown) });
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(HubEntry));
const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ resumed: Schema.Boolean })));
/** The part of HTTPS through `tailscale serve` that says whether the HTTPS address answers. */
const HttpsView = Schema.Struct({
  enabled: Schema.Boolean,
  listening: Schema.Boolean,
  forwarding: Schema.NullOr(Schema.Boolean),
});
const decodeRemoteAccess = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ status: Schema.Struct({ ...RemoteAccessView.fields, https: Schema.optionalKey(HttpsView) }) }),
  ),
);

/**
 * The stream connected. `resumed` is true when the hub replays every entry after the cursor the
 * main process sent, so nothing was missed while it was away (ADR 013).
 */
export interface HubConnected {
  readonly _tag: "Connected";
  readonly resumed: boolean;
}

/** The kinds of journal entry that make one of the main process's reads stale. */
const STALE: Readonly<Record<string, "Approvals" | "Questions" | "Tasks" | "Pairing" | undefined>> = {
  ApprovalRequested: "Approvals",
  ApprovalResolved: "Approvals",
  QuestionAsked: "Questions",
  QuestionEscalated: "Questions",
  QuestionAnswered: "Questions",
  QuestionWithdrawn: "Questions",
  TaskStateChanged: "Tasks",
  TaskCompleted: "Tasks",
  // A device asked to pair, or its request changed (ADR 021).
  PairingRequested: "Pairing",
  PairingChanged: "Pairing",
};

/** What a journal entry means for the main process: a finished Quest, a read it makes stale, or nothing. */
const entryChange = (entry: typeof HubEntry.Type | undefined): HubChange | null => {
  if (entry === undefined) return null;
  if (entry.type === "QuestCompleted") {
    const quest = finishedQuest(entry.payload);
    return quest === null ? null : { _tag: "QuestFinished", quest };
  }
  const stale = Object.hasOwn(STALE, entry.type) ? STALE[entry.type] : undefined;
  return stale === undefined ? null : { _tag: stale };
};

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
        onSome: ({ status: { https, ...status } }) => ({
          _tag: "RemoteAccess",
          ...status,
          servesHttps: https === undefined ? null : https.enabled && https.listening && https.forwarding === true,
        }),
      });
    case "message":
      return entryChange(Option.getOrUndefined(decodeEntry(frame.data)));
    default:
      return null;
  }
};
