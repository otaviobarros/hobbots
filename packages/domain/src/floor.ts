import type { AgentId } from "./ids.ts";
import { type TurnRequest, TurnRequests } from "./turn-request.ts";

/**
 * Who takes a line's floor next, decided in one place (ADR 039, One hob speaks at a time; #1549).
 * `decideFloor` reads a `FloorSnapshot`, everything the decision needs, and returns one
 * `FloorAction`. It does no I/O: the runner reads the snapshot and performs the action under the
 * line's lock, and nothing else starts a turn or a dispatch on a line.
 */

/** What the floor knows of one hob, for one line. */
export interface FloorHob {
  readonly hobId: AgentId;
  /**
   * Whether the hob takes work there now: awake, and, while it finishes its open Tasks before it
   * retires, only where one of them is open (#408). A member hob's rules come from its own record.
   */
  readonly available: boolean;
  /** Whether the hob is the thread's own hob or one of its active members: only those speak or carry work there. */
  readonly member: boolean;
  /** Whether you stopped a turn of the hob's that carried backpack work there: its work waits for you. */
  readonly held: boolean;
  /** Whether backpack work that needs the hob waits for it in this line (ADR 019). */
  readonly work: boolean;
  /** Whether routine progress waits for it there: it rides along a turn of its own, never starts one (IN-005). */
  readonly progress: boolean;
}

/**
 * Where the line's floor stands when the decision is asked: free, with nothing running, or in a
 * dispatch whose backpack work for `hobId` is ready for its turn, the work's facts with it.
 */
export type FloorPhase =
  | { readonly _tag: "Free" }
  | {
      readonly _tag: "Carrying";
      readonly hobId: AgentId;
      /** The work is routine progress only: it rides along a request of its hob's, or waits. */
      readonly routineOnly: boolean;
      /** Every item of the work that needs the hob went late since it was planned (#993). */
      readonly late: boolean;
    };

/** Everything `decideFloor` reads, as the runner found it under the line's lock. */
export interface FloorSnapshot {
  readonly phase: FloorPhase;
  /** Whether the thread exists and takes new turns: an archived thread is read-only until restored. */
  readonly open: boolean;
  /**
   * Whether the hub holds what waited after a restore, until you resume work (ADR 026): only the
   * message you just sent (`sent`) still starts, carrying nothing.
   */
  readonly restoring: boolean;
  /** The message of yours being sent now, which starts even while the hub holds work; null otherwise. */
  readonly sent: TurnRequest["messageId"] | null;
  /** Whether the hub has a backpack: without one, a line starts only its requests. */
  readonly backpack: boolean;
  /** The line's requests still owed, in any order. */
  readonly requests: ReadonlyArray<TurnRequest>;
  /** The message Send now picked, whose requests go first. */
  readonly chosen: TurnRequest["messageId"] | null;
  /**
   * The hobs the floor may go to: the thread's own hob, then its members as they joined, then any
   * other hob a request waits for. Their order is the order a carrier of work is picked in.
   */
  readonly hobs: ReadonlyArray<FloorHob>;
  /** Whether a message of yours waits in the thread's queue: it takes the work you stopped with it. */
  readonly queued: boolean;
}

/** What the runner does with the line's floor. */
export type FloorAction =
  /** Nobody takes the floor now: the line says who waits, and what changes a fact wakes it again. */
  | { readonly _tag: "Idle" }
  /**
   * The request's hob takes the floor, in a turn answering it. With `carries`, the turn is the one
   * its dispatch planned, and the backpack work rides along.
   */
  | { readonly _tag: "Start"; readonly request: TurnRequest; readonly carries: boolean }
  /** The dispatcher puts the backpack work waiting for `hobId` there into the line's next turn. */
  | { readonly _tag: "Dispatch"; readonly hobId: AgentId }
  /** The dispatch's work starts a turn of its own, a continuation whose prompt is the work. */
  | { readonly _tag: "Continue"; readonly hobId: AgentId };

/** The decision: the action, and whether the work you stopped there is released first. */
export interface FloorDecision {
  readonly action: FloorAction;
  /** A message of yours waits there, so the work you stopped goes along with it again. */
  readonly release: boolean;
}

const IDLE: FloorAction = { _tag: "Idle" };

/**
 * While the hub holds what waited after a restore, nothing that waited starts, and no backpack work
 * goes anywhere: only a request of the message you just sent takes a free floor, in its turn after
 * the requests already owed (ADR 026).
 */
const whileRestoring = (snapshot: FloorSnapshot): FloorAction => {
  if (snapshot.phase._tag !== "Free" || snapshot.sent === null) return IDLE;
  const next = nextRequest(snapshot);
  return next !== null && next.messageId === snapshot.sent ? { _tag: "Start", request: next, carries: false } : IDLE;
};

/** The hob as the snapshot knows it, with the holds the decision released taken off. */
const hobIn = (snapshot: FloorSnapshot, release: boolean): HobOf => {
  const hobs = new Map(snapshot.hobs.map((hob) => [hob.hobId, release ? { ...hob, held: false } : hob]));
  return (hobId) => hobs.get(hobId);
};

/**
 * The request the floor goes to next: the oldest waiting one whose hob is of the camp and takes work
 * now, a request of the message Send now picked first; null while one speaks or nobody waiting can
 * speak. Only a hob of the camp speaks there (ADR 039).
 */
export const nextRequest = (snapshot: FloorSnapshot): TurnRequest | null => {
  const hob = hobIn(snapshot, false);
  const speaks = (request: TurnRequest) => {
    const facts = hob(request.hobId);
    return facts?.available === true && facts.member;
  };
  return TurnRequests.next(snapshot.requests, speaks, snapshot.chosen);
};

/** Whether the hob may carry its work into this line now: a hob of the camp, awake there, and not held. */
const carries = (hob: FloorHob | undefined): hob is FloorHob => hob?.member === true && hob.available && !hob.held;

/**
 * The floor's decision for one line (ADR 039, One hob speaks at a time; ADR 019). In one place:
 * - an archived thread admits nothing, nothing starts beside a request that speaks, and a hub
 *   holding what waited after a restore admits only the message you just sent, carrying nothing;
 * - the oldest waiting request goes first, Send now's pick ahead of it, skipping a hob that cannot
 *   take work now;
 * - a request's hob carries along only its own work, and only while you have not held it there:
 *   with work or routine progress waiting, its request starts through a dispatch, else at once;
 * - with no request to start, the first hob of the camp with work that needs it carries that work;
 * - in a dispatch, the work rides along its hob's request when that one is next, else starts a
 *   continuation, unless it is routine progress only, or went late (#993);
 * - a message of yours waiting there takes the work you stopped with it.
 */
export const decideFloor = (snapshot: FloorSnapshot): FloorDecision => {
  if (!snapshot.open) return { action: IDLE, release: false };
  const { phase } = snapshot;
  // A request that speaks holds the floor: no other turn or dispatch starts beside it.
  if (phase._tag === "Free" && snapshot.requests.some(TurnRequests.isSpeaking)) return { action: IDLE, release: false };
  if (snapshot.restoring) return { action: whileRestoring(snapshot), release: false };
  const next = nextRequest(snapshot);
  if (phase._tag === "Carrying") return { action: inDispatch(phase, hobIn(snapshot, false), next), release: false };
  // Only a free floor takes your queued message's start, so only it releases what you stopped.
  const release = snapshot.queued && snapshot.hobs.some((hob) => hob.held);
  return { action: onFreeFloor(snapshot, hobIn(snapshot, release), next), release };
};

/** The hob a decision reads, by id. */
type HobOf = (hobId: AgentId) => FloorHob | undefined;

/**
 * In a dispatch whose work waits for `phase.hobId`: the work rides along its hob's request when that
 * one is next, else starts a continuation, unless it is routine progress only, or went late (#993).
 */
const inDispatch = (phase: Extract<FloorPhase, { _tag: "Carrying" }>, hob: HobOf, next: TurnRequest | null) => {
  if (!carries(hob(phase.hobId))) return IDLE;
  if (next?.hobId === phase.hobId) return { _tag: "Start", request: next, carries: true } satisfies FloorAction;
  return phase.routineOnly || phase.late ? IDLE : ({ _tag: "Continue", hobId: phase.hobId } satisfies FloorAction);
};

/**
 * On a free floor: the next request starts, through a dispatch when its hob carries work or routine
 * progress there, and with none to start the first hob of the camp with work that needs it carries it.
 */
const onFreeFloor = (snapshot: FloorSnapshot, hob: HobOf, next: TurnRequest | null): FloorAction => {
  if (next !== null) {
    const speaker = hob(next.hobId);
    const withWork = snapshot.backpack && carries(speaker) && (speaker.work || speaker.progress);
    return withWork ? { _tag: "Dispatch", hobId: next.hobId } : { _tag: "Start", request: next, carries: false };
  }
  if (!snapshot.backpack) return IDLE;
  const carrier = snapshot.hobs.map((each) => hob(each.hobId)).find((each) => carries(each) && each.work);
  return carrier === undefined ? IDLE : { _tag: "Dispatch", hobId: carrier.hobId };
};

/**
 * Whether `request`, owed for a message you are sending now, would take the line's free floor at
 * once: no request ahead of it can speak, and no backpack work of its hob has to go first. Sending
 * it releases the work you stopped there, as any message of yours does.
 */
export const startsAtOnce = (snapshot: FloorSnapshot, request: TurnRequest): boolean => {
  const { action } = decideFloor({
    ...snapshot,
    phase: { _tag: "Free" },
    requests: [...snapshot.requests, request],
    sent: request.messageId,
    queued: true,
  });
  return action._tag === "Start" && action.request.id === request.id;
};
