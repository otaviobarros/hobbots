import type { AgentId, CarriedItem, MessageId, RuntimeKind, ThreadId } from "@hobbots/domain";
import { Context, type Effect } from "effect";
import type { HubTools } from "./runtime.ts";

/** A chat turn that may work on a Task: the hob, its thread, the prompt and the brain it runs on. */
export interface ChatTurn {
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  /** The reply the turn writes. A key is idempotent within it, Continue included. */
  readonly messageId: MessageId;
  /** The turn's prompt, which becomes the brief of a Task the turn starts. */
  readonly prompt: string;
  readonly runtime: RuntimeKind;
  readonly configVersion: number;
  /**
   * The backpack items the turn was given under claims it holds (ADR 019), as a continuation is:
   * its `complete_task` consumes them with the items its briefing shows.
   */
  readonly holding?: ReadonlyArray<CarriedItem>;
}

/** How a chat turn ended, for the Attempt it may have started on its Task. */
export type ChatTurnOutcome = "completed" | "failed" | "interrupted";

/** What a chat turn gets for the Task its hob works on in the thread. */
export interface ChatTaskTurn {
  /** The Task tools the turn offers its runtime; the hub checks every call. */
  readonly hubTools: HubTools;
  /**
   * What the turn's session needs to know of the open Task: the state, checkpoints and results of
   * the Tasks under it, never their sessions. Null when the hob works on no open Task here.
   */
  readonly briefing: string | null;
  /** Ends the Attempt the turn started on its Task, if it started one. */
  readonly end: (outcome: ChatTurnOutcome, sessionId: string | null) => Effect.Effect<void>;
}

/**
 * Work hobs do on Tasks (ADR 018): the Task tools a chat turn offers, and the steps that run in
 * their own sessions while the hob keeps chatting. Absent, chat turns offer no Task tools.
 */
export class TaskTurns extends Context.Service<
  TaskTurns,
  {
    readonly forChat: (turn: ChatTurn) => Effect.Effect<ChatTaskTurn>;
    /** Starts the hob's steps that are ready, as when it wakes. */
    readonly drainAgent: (agentId: AgentId) => Effect.Effect<void>;
    /** Stops every step the hob runs and waits until each has ended. */
    readonly interruptAgent: (agentId: AgentId) => Effect.Effect<void>;
    /**
     * Stops, and waits for, every running step of the hob (or of every hob) whose tools the current
     * policy narrows (PE-008).
     */
    readonly reviewAuthority: (agentId?: AgentId) => Effect.Effect<void>;
  }
>()("@hobbots/agents/TaskTurns") {}
