import { Effect, Schema } from "effect";
import { Actor } from "./actor.ts";
import { AgentId, MessageId, ChannelId } from "./ids.ts";
import { defineMachine } from "./machine.ts";

/**
 * The floor of a conversation (ADR 039, One hob speaks at a time): each answer a hob owes is a
 * `TurnRequest`, written with the message that caused it, and a conversation runs one chat turn at
 * a time, the oldest request first. A request is a reply owed, not work: work for a hob still goes
 * only in its backpack (ADR 019).
 */

export const TurnRequestId = Schema.String.pipe(Schema.brand("TurnRequestId"));
export type TurnRequestId = typeof TurnRequestId.Type;

/**
 * One conversation of a channel (ADR 039): its main line, with no root message, or one of its reply
 * channels, named by the message it replies under. Each has its own floor.
 */
export interface Line {
  readonly channelId: ChannelId;
  readonly rootMessageId: MessageId | null;
}

/** A channel's main line. */
export const mainLine = (channelId: ChannelId): Line => ({ channelId, rootMessageId: null });

/** The line as one string, to key what is kept per line. */
export const lineKey = (line: Line): string =>
  line.rootMessageId === null ? line.channelId : `${line.channelId}/${line.rootMessageId}`;

/** Why the hob owes the answer, as `answerersFor` decided it; the turn's header says it. */
export const TurnCause = Schema.Literals(["mention", "reply", "relay", "only-hob", "lead"]);
export type TurnCause = typeof TurnCause.Type;

/** Where a request stands, held by `TurnRequestMachine`. */
export const TurnRequestState = Schema.Literals(["waiting", "paused", "speaking", "answered", "passed", "dropped"]);
export type TurnRequestState = typeof TurnRequestState.Type;

export class TurnRequest extends Schema.Class<TurnRequest>("TurnRequest")({
  id: TurnRequestId,
  channelId: ChannelId,
  /** The conversation it is owed in: null for the channel's main line. */
  rootMessageId: Schema.NullOr(MessageId),
  /** The hob that owes the answer. */
  hobId: AgentId,
  /** The message that caused it. */
  messageId: MessageId,
  /** Who wrote that message: a person, or a hob that mentioned another. */
  causedBy: Actor,
  cause: TurnCause,
  /** 0 for a request a person caused; a hob's mention adds one to its own turn's depth. */
  relayDepth: Schema.Int,
  /** Only `TurnRequestMachine` changes it, and code outside reads it through `TurnRequests`. */
  state: TurnRequestState,
  /** The reply of the turn that took it, from the moment it speaks; null while it waits. */
  replyId: Schema.NullOr(MessageId),
  /** Who stopped it, once dropped by Stop or Stop all; null otherwise, or when the hub dropped it. */
  droppedBy: Schema.NullOr(Actor),
  /**
   * Why its hob passed, in the hob's words: written as the hob passes, while it still speaks, so a
   * restart passes it too, and kept once `passed`. Null otherwise.
   */
  passReason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The revision of the message that caused it, which orders the floor. */
  queuedAt: Schema.Int,
  /** Its place among the requests that message caused, in the order `answerersFor` gave them. */
  position: Schema.Int,
  createdAt: Schema.String,
}) {}

/** What can happen to a request. */
export type TurnRequestEvent =
  /** Its hob takes the floor, in the turn writing `replyId`. */
  | { readonly _tag: "Speak"; readonly replyId: MessageId }
  /** The turn that took it ended, however it ended, as a turn the hub stopped does at a restart. */
  | { readonly _tag: "Answer" }
  /** The hob ended its turn with no message (the `pass` tool), saying why. */
  | { readonly _tag: "Pass"; readonly reason: string }
  /** Stop or Stop all dropped it, recording who stopped it; null when the hub dropped it. */
  | { readonly _tag: "Drop"; readonly by: Actor | null }
  /**
   * A person let the hobs go on past the relay budget: the paused request waits again, at depth
   * `RESUMED_RELAY_DEPTH`, so its turn counts as the first of the budget's next turns.
   */
  | { readonly _tag: "GoOn" };

/** A change to a request its state does not allow. */
export class IllegalTurnRequestTransition extends Schema.TaggedError<IllegalTurnRequestTransition>()(
  "IllegalTurnRequestTransition",
  { id: TurnRequestId, from: TurnRequestState, to: TurnRequestState },
) {}

/**
 * How many turns hobs may wake each other for after a person's message (ADR 039, Hobs talking to
 * hobs): a request a person caused has depth 0, and each hob's mention adds one to the depth of the
 * turn that mentioned. A request deeper than the budget is written `paused`, so two hobs that
 * mention each other stop after this many turns and wait for a person.
 */
export const HOB_RELAY_BUDGET = 3;

/** The depth Let them go on gives a paused request: its turn is the first of the budget's next turns. */
export const RESUMED_RELAY_DEPTH = 1;

/** The depth of the requests a reply's mentions cause: one more than the deepest its turn answered, 1 for a turn nobody asked for. */
export const relayDepthAfter = (answered: ReadonlyArray<TurnRequest>): number =>
  Math.max(0, ...answered.map((request) => request.relayDepth)) + 1;

/** Where a new request at `relayDepth` starts: waiting within the relay budget, paused past it. */
export const relayStateFor = (relayDepth: number): "waiting" | "paused" =>
  relayDepth > HOB_RELAY_BUDGET ? "paused" : "waiting";

/**
 * A request's lifecycle (ADR 039, One hob speaks at a time), declared once. A request past the
 * relay budget is written `paused`, and waits again only when a person lets the hobs go on.
 */
export const TurnRequestMachine = defineMachine<
  TurnRequestState,
  TurnRequestEvent,
  TurnRequest,
  IllegalTurnRequestTransition
>({
  name: "TurnRequest",
  states: {
    waiting: "Owed and in line for the floor",
    paused: "Past the relay budget: kept, wakes nobody, until a person lets the hobs go on",
    speaking: "Its hob holds the floor, in the turn writing its reply",
    answered: "The turn that took it ended",
    passed: "Its hob ended the turn with no message",
    dropped: "Stop or Stop all dropped it, recording who stopped it",
  },
  field: "state",
  events: {
    Speak: {
      from: ["waiting"],
      to: "speaking",
      apply: (request, event) => new TurnRequest({ ...request, state: "speaking", replyId: event.replyId }),
    },
    Answer: {
      from: ["speaking"],
      to: "answered",
      // A pass its turn did not keep leaves no reason behind (#1462).
      apply: (request) => new TurnRequest({ ...request, state: "answered", passReason: null }),
    },
    Pass: {
      from: ["speaking"],
      to: "passed",
      apply: (request, event) => new TurnRequest({ ...request, state: "passed", passReason: event.reason }),
    },
    Drop: {
      from: ["waiting", "paused", "speaking"],
      to: "dropped",
      apply: (request, event) =>
        new TurnRequest({ ...request, state: "dropped", droppedBy: event.by, passReason: null }),
    },
    GoOn: {
      from: ["paused"],
      to: "waiting",
      apply: (request) => new TurnRequest({ ...request, state: "waiting", relayDepth: RESUMED_RELAY_DEPTH }),
    },
  },
  illegal: (request, _event, to) => new IllegalTurnRequestTransition({ id: request.id, from: request.state, to }),
});

const OPEN: ReadonlyArray<TurnRequestState> = ["waiting", "paused", "speaking"];

/** Floor order: the message that caused it first, then its place among that message's requests. */
const byFloorOrder = (a: TurnRequest, b: TurnRequest): number => a.queuedAt - b.queuedAt || a.position - b.position;

/**
 * `TurnRequestMachine` with the questions code outside this module asks of a request's state, and
 * the floor's rules over one line's requests.
 */
export const TurnRequests = {
  ...TurnRequestMachine,
  /** Whether the request is still owed: waiting, paused or speaking. */
  isOpen: (request: TurnRequest): boolean => OPEN.includes(request.state),
  isWaiting: (request: TurnRequest): boolean => request.state === "waiting",
  isSpeaking: (request: TurnRequest): boolean => request.state === "speaking",
  isPaused: (request: TurnRequest): boolean => request.state === "paused",
  /** Whether Stop, Stop all or the hub dropped it. */
  isDropped: (request: TurnRequest): boolean => request.state === "dropped",
  /** The requests past the relay budget, oldest first: what Let them go on wakes and your message drops. */
  paused: (requests: ReadonlyArray<TurnRequest>): ReadonlyArray<TurnRequest> =>
    requests.filter((request) => request.state === "paused").toSorted(byFloorOrder),
  /**
   * The hobs a line's relay paused between, each once, in the order they relayed: for each paused
   * request, the hob whose mention caused it, then the hob it is owed by. Empty while none is paused.
   */
  pausedHobs: (requests: ReadonlyArray<TurnRequest>): ReadonlyArray<AgentId> => [
    ...new Set(
      TurnRequests.paused(requests).flatMap((request) => [
        ...(request.causedBy.kind === "hob" ? [AgentId.make(request.causedBy.id)] : []),
        request.hobId,
      ]),
    ),
  ],
  /** The request whose hob holds the floor, if any. */
  speaking: (requests: ReadonlyArray<TurnRequest>): TurnRequest | null =>
    requests.find((request) => request.state === "speaking") ?? null,
  /** The waiting requests, oldest first. */
  waiting: (requests: ReadonlyArray<TurnRequest>): ReadonlyArray<TurnRequest> =>
    requests.filter((request) => request.state === "waiting").toSorted(byFloorOrder),
  /**
   * Who takes the floor next: the oldest waiting request whose hob `canSpeak`, a request of the
   * message Send now picked (`chosen`) ahead of the rest. Null while one speaks, or none can.
   */
  next: (
    requests: ReadonlyArray<TurnRequest>,
    canSpeak: (request: TurnRequest) => boolean = () => true,
    chosen: MessageId | null = null,
  ): TurnRequest | null => {
    if (requests.some((request) => request.state === "speaking")) return null;
    const ready = TurnRequests.waiting(requests).filter(canSpeak);
    return ready.find((request) => request.messageId === chosen) ?? ready[0] ?? null;
  },
  /**
   * What Stop drops: the speaking request, and the requests its turn caused by mentioning other
   * hobs. Requests a person caused stay waiting: Stop never cancels what someone else asked for.
   */
  stopping: (requests: ReadonlyArray<TurnRequest>): ReadonlyArray<TurnRequest> => {
    const speaking = TurnRequests.speaking(requests);
    if (speaking === null) return [];
    const caused = requests.filter(
      (request) =>
        (request.state === "waiting" || request.state === "paused") &&
        speaking.replyId !== null &&
        request.messageId === speaking.replyId,
    );
    return [speaking, ...caused];
  },
  /** What Stop all drops: every request still owed in the line. */
  stoppingAll: (requests: ReadonlyArray<TurnRequest>): ReadonlyArray<TurnRequest> =>
    requests.filter((request) => OPEN.includes(request.state)),
};
