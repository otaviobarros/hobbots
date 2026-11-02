import type { AgentId, CarriedItem, MessageId, ThreadId } from "@hobbots/domain";
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

/** How a turn that carried work ended: it ran to its end, or ended early, and why. */
export type CarriedEnd = { readonly _tag: "Handled" } | { readonly _tag: "EndedEarly"; readonly reason: string };

/** The turn a thread's chat runs for the work that waits there. */
export interface CarryingTurn {
  /**
   * The reply the next turn will write, or null when no turn can start now: the work stays pending.
   * With `routineOnly`, only routine progress waits, so a turn starts only for a message of yours.
   */
  readonly plan: (routineOnly: boolean) => Effect.Effect<MessageId | null>;
  /** Runs that turn with the work put into it, and returns once it has ended. */
  readonly run: (replyId: MessageId, work: CarriedWork) => Effect.Effect<CarriedEnd>;
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
