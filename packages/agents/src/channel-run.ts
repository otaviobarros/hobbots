import type { AgentId, ChannelRunStatus, Line, Message, MessageId, ReplyActivity } from "@hobbots/domain";
import { ChannelRunState, defineMachine, type MachineEdge } from "@hobbots/domain";
import type { Deferred, Ref, Semaphore } from "effect";

/**
 * A line's run (ADR 037, ADR 039): whether a turn holds the floor of a conversation, which hob speaks
 * and who is next. It lives in memory, as turns do; what waits is the records, the `TurnRequest`s and
 * the backpack, so at start every line is idle and those records start it again. `ChatService`
 * keeps every line's run in one `Ref`, changed only through `ChannelRunMachine`, and publishes each
 * transition as `ChannelRunChanged`.
 */

/**
 * Where a channel's run stands. A channel is busy in every state but `idle`, so later prompts queue.
 * Whether the running reply is stopping is the reply's own state, not the run's.
 */
export type RunState = ChannelRunState;

/** The reply a running turn is writing, so a stop request can reach it. */
export interface Reply {
  readonly current: Ref.Ref<Message>;
  readonly lock: Semaphore.Semaphore;
  /** How many steps the reply had from earlier turns when Continue resumed it; this turn's come after. */
  readonly stepsFrom: number;
  /** The text the reply already had when Continue resumed it; the runtime's final text comes after it. */
  readonly prefix: string;
  /** Whether the turn carries work that needs the hob, so a stop holds it back until you write again. */
  readonly carries: boolean;
  /** Done once you press Stop waiting, which ends the turn while it only waits on commands (#1056). */
  readonly endWait: Deferred.Deferred<void>;
  /** How many commands Stop waiting stopped, once it has ended the turn's stream; null before. */
  readonly waitsStopped: Ref.Ref<number | null>;
  /** Why the hob passed, once it called `pass` (ADR 039): the turn then ends with no message. */
  readonly passed: Ref.Ref<string | null>;
}

export interface ChannelRun {
  readonly run: RunState;
  /** The hob whose turn runs there, while `running` or `carrying`. */
  readonly speaking: AgentId | null;
  /**
   * The hob whose backpack work the dispatcher puts through, while `dispatching` or `carrying`, so
   * Stop all can hold that work before its turn launches (ADR 039).
   */
  readonly carrier: AgentId | null;
  /** The hobs whose requests wait for the floor, in the order they will speak, each once. */
  readonly next: ReadonlyArray<AgentId>;
  /** The hobs whose relay went past the budget there and waits for a person, each once (#1463). */
  readonly paused: ReadonlyArray<AgentId>;
  /** The reply of the turn running there, while `running` or `carrying`. */
  readonly reply: Reply | null;
  /** What that reply is doing, while it runs; null with no reply. */
  readonly activity: ReplyActivity | null;
  /** The queued message Send now picked to start next. After a restart the queue keeps its order. */
  readonly chosen: MessageId | null;
  /**
   * The hobs whose turns carrying backpack work you stopped here: each one's work waits for your
   * next message, or for that hob to wake, instead of starting again on its own. A restart
   * delivers it again.
   */
  readonly held: ReadonlyArray<AgentId>;
}

export type ChannelRunEvent =
  /** The dispatcher starts putting the backpack work waiting there for `hobId` into the line's next turn. */
  | { readonly _tag: "Dispatch"; readonly hobId: AgentId }
  /** A turn of `hobId` starts, with the reply it writes and what that reply is doing. */
  | { readonly _tag: "Launch"; readonly hobId: AgentId; readonly reply: Reply; readonly activity: ReplyActivity | null }
  /** The running reply changed what it is doing; a stale reply, or no change, changes nothing. */
  | { readonly _tag: "ReplyChanged"; readonly reply: Reply; readonly activity: ReplyActivity | null }
  /** A turn has ended; a stale reply, already replaced, changes nothing. */
  | { readonly _tag: "TurnEnded"; readonly reply: Reply }
  /** The ended turn's drain frees the channel. */
  | { readonly _tag: "Drained" }
  /** The dispatcher has delivered the work and frees the channel. */
  | { readonly _tag: "Delivered" }
  /** The requests owed there changed; `next` is who waits for the floor now, `paused` whose relay waits for a person. */
  | { readonly _tag: "Lined"; readonly next: ReadonlyArray<AgentId>; readonly paused: ReadonlyArray<AgentId> }
  /** Send now picked a queued message. */
  | { readonly _tag: "Choose"; readonly messageId: MessageId }
  /** The chosen message was taken from the queue, or removed from it. */
  | { readonly _tag: "Unchoose"; readonly messageId: MessageId | null }
  /** You stopped a turn that carried backpack work. */
  | { readonly _tag: "Hold"; readonly hobId: AgentId }
  /**
   * Work you stopped may start again: you wrote or resumed it, or, with `hobId`, that hob woke, which
   * leaves another hob's stopped work held.
   */
  | { readonly _tag: "Release"; readonly hobId?: AgentId };

export const RUN_STATES: ReadonlyArray<RunState> = ChannelRunState.literals;
/** A channel with nothing running and nothing remembered. */
export const idleRun: ChannelRun = {
  run: "idle",
  speaking: null,
  carrier: null,
  next: [],
  paused: [],
  reply: null,
  activity: null,
  chosen: null,
  held: [],
};

const sameHobs = (a: ReadonlyArray<AgentId>, b: ReadonlyArray<AgentId>) =>
  a.length === b.length && a.every((hobId, i) => hobId === b[i]);

/** What a running reply is doing now, for `ReplyChanged`. */
interface ReplyChange {
  readonly reply: Reply;
  readonly activity: ReplyActivity | null;
}

/**
 * One rule per state in `states`, each staying in its state, for an event that changes only fields
 * other than the state, when `guard`, if any, holds.
 */
const staying = <E>(
  states: ReadonlyArray<RunState>,
  apply: (run: ChannelRun, event: E) => ChannelRun,
  guard?: (run: ChannelRun, event: E) => boolean,
) =>
  states.map(
    (state): MachineEdge<RunState, ChannelRun, E> =>
      guard === undefined ? { from: [state], to: state, apply } : { from: [state], to: state, guard, apply },
  );

export const ChannelRunMachine = defineMachine<RunState, ChannelRunEvent, ChannelRun, string>({
  name: "ChannelRun",
  states: {
    idle: "No turn runs and nothing is being dispatched; a prompt starts at once",
    dispatching: "The dispatcher is putting backpack work into the channel's next turn",
    running: "A turn runs, freed by its own drain when it ends",
    carrying: "A turn the dispatcher started runs, carrying backpack work",
    draining: "The turn has ended and its drain has yet to free the channel",
  },
  field: "run",
  events: {
    Dispatch: {
      from: ["idle"],
      to: "dispatching",
      apply: (r, e) => ({ ...r, run: "dispatching", carrier: e.hobId }),
    },
    Launch: [
      {
        from: ["idle"],
        to: "running",
        apply: (r, e) => ({ ...r, run: "running", speaking: e.hobId, reply: e.reply, activity: e.activity }),
      },
      {
        from: ["dispatching"],
        to: "carrying",
        apply: (r, e) => ({ ...r, run: "carrying", speaking: e.hobId, reply: e.reply, activity: e.activity }),
      },
    ],
    ReplyChanged: staying(
      ["running", "carrying"],
      (r, e: ReplyChange) => ({ ...r, activity: e.activity }),
      (r, e) => r.reply === e.reply && r.activity !== e.activity,
    ),
    TurnEnded: [
      {
        from: ["running"],
        to: "draining",
        guard: (r, e) => r.reply === e.reply,
        apply: (r) => ({ ...r, run: "draining", speaking: null, reply: null, activity: null }),
      },
      {
        from: ["carrying"],
        to: "dispatching",
        guard: (r, e) => r.reply === e.reply,
        apply: (r) => ({ ...r, run: "dispatching", speaking: null, reply: null, activity: null }),
      },
    ],
    // A drain with nothing left to free, as for a channel that was removed, changes nothing.
    Drained: [
      { from: ["draining"], to: "idle", apply: (r) => ({ ...r, run: "idle" }) },
      { from: ["idle"], to: "idle", apply: (r) => r },
    ],
    Delivered: { from: ["dispatching"], to: "idle", apply: (r) => ({ ...r, run: "idle", carrier: null }) },
    // Only a change is a transition, so the run publishes who is next, or paused, only when it changes.
    Lined: staying(
      RUN_STATES,
      (r, e: { readonly next: ReadonlyArray<AgentId>; readonly paused: ReadonlyArray<AgentId> }) => ({
        ...r,
        next: e.next,
        paused: e.paused,
      }),
      (r, e) => !sameHobs(r.next, e.next) || !sameHobs(r.paused, e.paused),
    ),
    Choose: staying(RUN_STATES, (r, e: { readonly messageId: MessageId }) => ({ ...r, chosen: e.messageId })),
    Unchoose: staying(RUN_STATES, (r, e: { readonly messageId: MessageId | null }) =>
      e.messageId === null || r.chosen === e.messageId ? { ...r, chosen: null } : r,
    ),
    // A stop reaches a running reply, but the turn may have ended by the time the stop is saved.
    // Each hob's stop is kept: stopping another hob's turn leaves the first one's work held.
    Hold: staying(RUN_STATES, (r, e: { readonly hobId: AgentId }) =>
      r.held.includes(e.hobId) ? r : { ...r, held: [...r.held, e.hobId] },
    ),
    Release: staying(RUN_STATES, (r, e: { readonly hobId?: AgentId }) =>
      e.hobId === undefined
        ? { ...r, held: [] }
        : r.held.includes(e.hobId)
          ? { ...r, held: r.held.filter((hobId) => hobId !== e.hobId) }
          : r,
    ),
  },
  illegal: (r, e, to) => `ChannelRun: ${e._tag} cannot move a run from ${r.run} to ${to}`,
});

/** Whether the dispatcher is putting backpack work through and no turn of it has launched yet. */
export const isDispatching = (run: ChannelRun) => run.run === "dispatching";

/** Whether a turn runs in the channel or its work is being dispatched, so a prompt waits. */
export const isBusy = (run: ChannelRun) => run.run !== "idle";

/** Whether the run is idle and remembers nothing, so it need not be kept. */
export const isAtRest = (run: ChannelRun) =>
  run.run === "idle" &&
  run.chosen === null &&
  run.held.length === 0 &&
  run.next.length === 0 &&
  run.paused.length === 0;

/** The run of `line` as the hub publishes it, at `revision`. */
export const runStatus = (line: Line, run: ChannelRun, revision: number): ChannelRunStatus => ({
  channelId: line.channelId,
  rootMessageId: line.rootMessageId,
  run: run.run,
  reply: run.activity,
  speaking: run.speaking,
  next: run.next,
  paused: run.paused,
  revision,
});
