import type { Message, MessageId } from "@hobbots/domain";
import { defineMachine, type MachineEdge } from "@hobbots/domain";
import type { Deferred, Ref, Semaphore } from "effect";

/**
 * A thread's run (ADR 037): whether a turn runs there, and what waits for the thread to be free. It
 * lives in memory, as turns do; at start every thread is idle, and queued messages and backpack work
 * start it again. `ChatService` keeps every thread's run in one `Ref`, changed only through
 * `ThreadRunMachine`.
 */

/**
 * Where a thread's run stands. A thread is busy in every state but `idle`, so later prompts queue.
 * Whether the running reply is stopping is the reply's own state, not the run's.
 */
export type RunState = "idle" | "dispatching" | "running" | "carrying" | "draining";

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
}

export interface ThreadRun {
  readonly run: RunState;
  /** The reply of the turn running there, while `running` or `carrying`. */
  readonly reply: Reply | null;
  /** The queued message Send now picked to start next. After a restart the queue keeps its order. */
  readonly chosen: MessageId | null;
  /**
   * Whether you stopped a turn carrying backpack work here: the work waits for your next message, or
   * for the hob to wake, instead of starting again on its own. A restart delivers it again.
   */
  readonly held: boolean;
  /**
   * Whether the thread was woken while busy, as when work arrives for its hob: once free, what waits
   * there is looked at again, so work that arrived after the dispatcher looked waits no longer.
   */
  readonly wakePending: boolean;
}

export type ThreadRunEvent =
  /** The dispatcher starts putting the backpack work waiting there into the thread's next turn. */
  | { readonly _tag: "Dispatch" }
  /** A turn starts, with the reply it writes. */
  | { readonly _tag: "Launch"; readonly reply: Reply }
  /** A turn has ended; a stale reply, already replaced, changes nothing. */
  | { readonly _tag: "TurnEnded"; readonly reply: Reply }
  /** The ended turn's drain frees the thread. */
  | { readonly _tag: "Drained" }
  /** The dispatcher has delivered the work and frees the thread. */
  | { readonly _tag: "Delivered" }
  /** Something woke the thread while it was busy. */
  | { readonly _tag: "WakeLater" }
  /** Send now picked a queued message. */
  | { readonly _tag: "Choose"; readonly messageId: MessageId }
  /** The chosen message was taken from the queue, or removed from it. */
  | { readonly _tag: "Unchoose"; readonly messageId: MessageId | null }
  /** You stopped a turn that carried backpack work. */
  | { readonly _tag: "Hold" }
  /** Work you stopped may start again: you wrote, resumed it, or its hob woke. */
  | { readonly _tag: "Release" };

export const RUN_STATES: ReadonlyArray<RunState> = ["idle", "dispatching", "running", "carrying", "draining"];
const BUSY: ReadonlyArray<RunState> = ["dispatching", "running", "carrying", "draining"];

/** A thread with nothing running and nothing remembered. */
export const idleRun: ThreadRun = { run: "idle", reply: null, chosen: null, held: false, wakePending: false };

/** One rule per state in `states`, each staying in its state, for an event that changes only flags. */
const staying = <E>(states: ReadonlyArray<RunState>, apply: (run: ThreadRun, event: E) => ThreadRun) =>
  states.map((state): MachineEdge<RunState, ThreadRun, E> => ({ from: [state], to: state, apply }));

export const ThreadRunMachine = defineMachine<RunState, ThreadRunEvent, ThreadRun, string>({
  name: "ThreadRun",
  states: {
    idle: "No turn runs and nothing is being dispatched; a prompt starts at once",
    dispatching: "The dispatcher is putting backpack work into the thread's next turn",
    running: "A turn runs, freed by its own drain when it ends",
    carrying: "A turn the dispatcher started runs, carrying backpack work",
    draining: "The turn has ended and its drain has yet to free the thread",
  },
  field: "run",
  events: {
    Dispatch: { from: ["idle"], to: "dispatching", apply: (r) => ({ ...r, run: "dispatching", wakePending: false }) },
    Launch: [
      { from: ["idle"], to: "running", apply: (r, e) => ({ ...r, run: "running", reply: e.reply }) },
      { from: ["dispatching"], to: "carrying", apply: (r, e) => ({ ...r, run: "carrying", reply: e.reply }) },
    ],
    TurnEnded: [
      {
        from: ["running"],
        to: "draining",
        guard: (r, e) => r.reply === e.reply,
        apply: (r) => ({ ...r, run: "draining", reply: null }),
      },
      {
        from: ["carrying"],
        to: "dispatching",
        guard: (r, e) => r.reply === e.reply,
        apply: (r) => ({ ...r, run: "dispatching", reply: null }),
      },
    ],
    // A drain with nothing left to free, as for a thread that was removed, changes nothing.
    Drained: [
      { from: ["draining"], to: "idle", apply: (r) => ({ ...r, run: "idle" }) },
      { from: ["idle"], to: "idle", apply: (r) => r },
    ],
    Delivered: { from: ["dispatching"], to: "idle", apply: (r) => ({ ...r, run: "idle", wakePending: false }) },
    WakeLater: staying(BUSY, (r) => ({ ...r, wakePending: true })),
    Choose: staying(RUN_STATES, (r, e: { readonly messageId: MessageId }) => ({ ...r, chosen: e.messageId })),
    Unchoose: staying(RUN_STATES, (r, e: { readonly messageId: MessageId | null }) =>
      e.messageId === null || r.chosen === e.messageId ? { ...r, chosen: null } : r,
    ),
    // A stop reaches a running reply, but the turn may have ended by the time the stop is saved.
    Hold: staying(RUN_STATES, (r) => ({ ...r, held: true })),
    Release: staying(RUN_STATES, (r) => ({ ...r, held: false })),
  },
  illegal: (r, e, to) => `ThreadRun: ${e._tag} cannot move a run from ${r.run} to ${to}`,
});

/** Whether a turn runs in the thread or its work is being dispatched, so a prompt waits. */
export const isBusy = (run: ThreadRun) => run.run !== "idle";

/** Whether the run is idle and remembers nothing, so it need not be kept. */
export const isAtRest = (run: ThreadRun) => run.run === "idle" && run.chosen === null && !run.held && !run.wakePending;
