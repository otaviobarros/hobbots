import type { AgentId, AttemptId, BackpackTurnEnding, CarriedItem, MessageId, TaskId, ThreadId } from "@hobbots/domain";
import { Context, type Effect } from "effect";

/** What arrived for a hob in a thread, put into one turn there under the claims the turn holds (ADR 019). */
export interface CarriedWork {
  /** What the turn is told of the items, written by Hobbots: as its prompt, or as context with your message. */
  readonly text: (as: "prompt" | "context") => string;
  /** The items and the claims the turn holds them under, so its `complete_task` consumes them. */
  readonly holding: ReadonlyArray<CarriedItem>;
  /** Records the adapter's evidence that the runtime accepted the turn: its session. */
  readonly accepted: (sessionId: string) => Effect.Effect<void>;
  /** True when the work is routine progress only: it rides along a message of yours and starts no turn alone (IN-005). */
  readonly routineOnly: boolean;
}

/**
 * How a turn that carried work ended: it ran to its end, or ended early, how as a code, and what the
 * runtime said about it, raw, when it said anything.
 */
export type CarriedEnd = { readonly _tag: "Handled" } | ({ readonly _tag: "EndedEarly" } & BackpackTurnEnding);

/**
 * The turn a session runs for the work that waits there: a thread's chat, whose turns are its
 * replies, or a member's Task, whose turns are Attempts.
 */
export interface CarryingTurn<Id extends string = MessageId> {
  /**
   * The id the next turn will have, or null when no turn can start now: the work stays pending.
   * With `routineOnly`, only routine progress waits, so a turn starts only for a message of yours.
   */
  readonly plan: (routineOnly: boolean) => Effect.Effect<Id | null>;
  /** Runs that turn with the work put into it, and returns once it has ended. */
  readonly run: (turnId: Id, work: CarriedWork) => Effect.Effect<CarriedEnd>;
}

/**
 * The one wake path of ADR 019, as the chat sees it: the backpack items waiting for a hob in a
 * thread, delivered into the thread's next turn. Every turn you did not start with Send starts
 * here. Absent, as in hubs and tests without a backpack, a thread starts only your queued messages.
 */
export class Continuations extends Context.Service<
  Continuations,
  {
    /** The threads where work waits for their hob: of one hob, or of every hob. */
    readonly waiting: (agentId?: AgentId) => Effect.Effect<ReadonlyArray<ThreadId>>;
    /** Whether routine progress waits for the hob in the thread, to ride along its next turn as a digest. */
    readonly progressWaits: (threadId: ThreadId, agentId: AgentId) => Effect.Effect<boolean>;
    /**
     * Puts every item waiting for the hob in the thread into one turn, and runs it with `turn`,
     * routine progress folded in as one digest. A turn that ends early is planned and run again
     * with backoff, until its items run out of deliveries. Returns whether any turn ran.
     */
    readonly deliver: (threadId: ThreadId, agentId: AgentId, turn: CarryingTurn) => Effect.Effect<boolean>;
  }
>()("@hobbots/agents/Continuations") {}

/** A member's Task with work waiting for its owner, in the session that works it. */
export interface MemberWorkWaiting {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
}

/**
 * The one wake path of ADR 019, as a party member's Task sees it: the backpack items its owner
 * holds under the Task, such as the Task itself, a hand-off or an answer, delivered into one turn
 * of the session that works it. Each turn is an Attempt of the Task. Absent, as in hubs and tests
 * without a backpack, no member's Task runs.
 */
export class MemberContinuations extends Context.Service<
  MemberContinuations,
  {
    /** The members' Tasks where work waits for their owner now. */
    readonly waiting: Effect.Effect<ReadonlyArray<MemberWorkWaiting>>;
    /**
     * Puts every item waiting for the hob under the Task into one turn, and runs it with `turn`, as
     * `Continuations.deliver` does for a thread. Returns whether any turn ran.
     */
    readonly deliver: (taskId: TaskId, agentId: AgentId, turn: CarryingTurn<AttemptId>) => Effect.Effect<boolean>;
  }
>()("@hobbots/agents/MemberContinuations") {}
