import type {
  AgentId,
  AttemptId,
  CarriedItem,
  MessageId,
  RuntimeKind,
  TaskBriefMark,
  TaskId,
  ThreadId,
  TurnEnding,
  WebReadMark,
} from "@hobbots/domain";
import { Context, type Effect } from "effect";
import type { CallWrites, HubTools } from "./runtime.ts";

/** A chat turn that may work on a Task: the hob, its thread, the prompt and the brain it runs on. */
export interface ChatTurn {
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  /** The reply the turn writes. A key is idempotent within it, Continue included. */
  readonly messageId: MessageId;
  /** The message of yours the turn answers; null for a continuation (ADR 019). */
  readonly promptId?: MessageId | null;
  /** The turn's prompt, which becomes the brief of a Task the turn starts. */
  readonly prompt: string;
  /**
   * The message of yours the turn answers, as you wrote it and when you sent it. Continue keeps it,
   * though its prompt is Hobbots' own, so a Task the turn delegates carries your words (#1005).
   */
  readonly yours?: { readonly text: string; readonly sentAt: string };
  readonly runtime: RuntimeKind;
  readonly configVersion: number;
  /**
   * The backpack items the turn was given under claims it holds (ADR 019), as a continuation is:
   * its `complete_task` consumes them with the items its briefing shows.
   */
  readonly holding?: ReadonlyArray<CarriedItem>;
  /**
   * What the session the turn resumes was last told of the Task it works on (#1027), so its
   * briefing says only what changed since. Absent or null for a session that needs the whole.
   */
  readonly told?: TaskBriefMark | null;
  /**
   * The read-the-web mark of the turn's session as it stands (ADR 036): each Attempt the turn
   * starts, from the start or partway through, records it as soon as the Attempt exists.
   */
  readonly webMark?: Effect.Effect<WebReadMark | null>;
}

/** What a chat turn gets for the Task its hob works on in the thread. */
export interface ChatTaskTurn {
  /** The Task tools the turn offers its runtime; the hub checks every call. */
  readonly hubTools: HubTools;
  /**
   * Why a `git commit` in the repository Git finds from `cwd` is held, or null when it may run: a
   * lead's commit where a member's open Task left changes, which are that member's to commit (#742).
   */
  readonly holdsCommit?: (cwd: string) => Effect.Effect<string | null>;
  /** Why a call's writes are refused: a path or branch you took over from a Task (#1449). */
  readonly takenByYou?: (writes: CallWrites) => Effect.Effect<string | null>;
  /**
   * What the turn's session needs to know of the open Task: the state, checkpoints and results of
   * the Tasks under it, never their sessions. Null when the hob works on no open Task here.
   */
  readonly briefing: string | null;
  /** What the session will have been told of the Task once it receives the briefing; null without one. */
  readonly told: TaskBriefMark | null;
  /**
   * The top Task the turn works on now, which This Task binds a grant to (ADR 018): null while it
   * works on none. A call that starts a Task changes it partway through the turn.
   */
  readonly workingOn: Effect.Effect<TaskId | null>;
  /**
   * The work the turn's tool call keys belong to (#660), from `callScope`: the Task it was briefed on,
   * else its reply. Fixed for the whole turn, so a retry of a call that started a Task is still a retry.
   */
  readonly scope: () => string;
  /**
   * `charms`, with each Charm call's refusal recorded as a Task tool's is, and a repository it created
   * recorded on the Task the turn works on (#664).
   */
  readonly recordCharms: (charms: HubTools | null) => HubTools | null;
  /** The Attempt the turn runs on its Task: from the start when briefed on one, once a call starts one, else null. */
  readonly attempt: Effect.Effect<AttemptId | null>;
  /** The folders the Quest on its Task works in, which the turn's activity is tracked in (#670); null for all. */
  readonly workIn: Effect.Effect<ReadonlyArray<string> | null>;
  /**
   * Whether the turn's reply, read as it completes, is routine progress the chat leaves out (#1006):
   * a turn on work that arrived, not on a message of yours, in a Quest that still runs, which
   * brought you no question. The plan, a question passed up to you and the finish always show.
   */
  readonly quiet: Effect.Effect<boolean>;
  /**
   * Ends the Attempt the turn started on its Task, if it started one, by the one turn-end decision,
   * with the session the turn ran in and the policy version its tools ran under.
   */
  readonly end: (ending: TurnEnding, sessionId: string | null, policyVersion: string | null) => Effect.Effect<void>;
  /**
   * Records the read-the-web mark of the turn's session (ADR 036) on the Attempt the turn runs on
   * its Task, if it runs one yet.
   */
  readonly readWeb: (mark: WebReadMark) => Effect.Effect<void>;
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
    /**
     * Looks at the Tasks again: stops the sessions whose cancel was asked for, confirms the cancels
     * nothing runs in any more, and starts what is ready.
     */
    readonly reviewTasks: Effect.Effect<void>;
    /** Stops every step the hob runs and waits until each has ended. */
    readonly interruptAgent: (agentId: AgentId) => Effect.Effect<void>;
    /**
     * Stops, and waits for, every running step of the hob (or of every hob) whose tools the current
     * policy narrows (PE-008).
     */
    readonly reviewAuthority: (agentId?: AgentId) => Effect.Effect<void>;
  }
>()("@hobbots/agents/TaskTurns") {}
