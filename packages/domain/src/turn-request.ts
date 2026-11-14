import { Schema } from "effect";
import { Actor } from "./actor.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
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
 * One conversation of a thread (ADR 039): its main line, with no root message, or one of its reply
 * threads, named by the message it replies under. Each has its own floor.
 */
export interface Line {
  readonly threadId: ThreadId;
  readonly rootMessageId: MessageId | null;
}

/** A thread's main line. */
export const mainLine = (threadId: ThreadId): Line => ({ threadId, rootMessageId: null });

/** The line as one string, to key what is kept per line. */
export const lineKey = (line: Line): string =>
  line.rootMessageId === null ? line.threadId : `${line.threadId}/${line.rootMessageId}`;

/** Why the hob owes the answer, as `answerersFor` decided it; the turn's header says it. */
export const TurnCause = Schema.Literals(["mention", "reply", "relay", "only-hob", "lead"]);
export type TurnCause = typeof TurnCause.Type;

/** Where a request stands, held by `TurnRequestMachine`. */
export const TurnRequestState = Schema.Literals(["waiting", "paused", "speaking", "answered", "passed", "dropped"]);
export type TurnRequestState = typeof TurnRequestState.Type;

export class TurnRequest extends Schema.Class<TurnRequest>("TurnRequest")({
  id: TurnRequestId,
  threadId: ThreadId,
  /** The conversation it is owed in: null for the thread's main line. */
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
  /** The hob ended its turn with no message (the `pass` tool). */
  | { readonly _tag: "Pass" }
  /** Stop or Stop all dropped it, recording who stopped it; null when the hub dropped it. */
  | { readonly _tag: "Drop"; readonly by: Actor | null };

/** A change to a request its state does not allow. */
export class IllegalTurnRequestTransition extends Schema.TaggedError<IllegalTurnRequestTransition>()(
  "IllegalTurnRequestTransition",
  { id: TurnRequestId, from: TurnRequestState, to: TurnRequestState },
) {}

/**
 * A request's lifecycle (ADR 039, One hob speaks at a time), declared once. A request past the
 * relay budget is written `paused`; what wakes it again comes with the relay budget (#1463).
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
      apply: (request) => new TurnRequest({ ...request, state: "answered" }),
    },
    Pass: { from: ["speaking"], to: "passed", apply: (request) => new TurnRequest({ ...request, state: "passed" }) },
    Drop: {
      from: ["waiting", "paused", "speaking"],
      to: "dropped",
      apply: (request, event) => new TurnRequest({ ...request, state: "dropped", droppedBy: event.by }),
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
