import type {
  Actor,
  AgentId,
  Answerer,
  ArtifactId,
  ArtifactKind,
  Attempt,
  AttemptEnd,
  AttemptId,
  BackpackItemId,
  CarriedItem,
  Checkpoint,
  CheckpointId,
  CheckpointKind,
  CheckpointSource,
  Committed,
  CriterionId,
  DelegationAuthority,
  DelegationId,
  DeviceId,
  EventEnvelope,
  FailedTask,
  HandOff,
  HistoryRecords,
  IllegalTaskTransition,
  MemberWork,
  MessageId,
  MilestoneId,
  NoteDelivery,
  NoteId,
  PausedFrom,
  Quest,
  QuestId,
  Question,
  QuestionId,
  QuestionOption,
  QuestionSurface,
  QuestLimits,
  QuestSummary,
  RefusedCall,
  ReplyUsage,
  ResponsibilityLedger,
  RuntimeKind,
  StaleTask,
  Task,
  TaskId,
  TaskNote,
  TaskRefused,
  TaskTarget,
  TaskToolDone,
  TaskToolName,
  TaskToolRefused,
  TaskTree,
  TaskWait,
  ThreadId,
  WaitMode,
  WebReadMark,
} from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";

/** A new Task. A child takes its parent's root and thread; `threadId` applies only to the Task you asked for. */
export interface NewTask {
  readonly id: TaskId;
  readonly ownerId: AgentId;
  readonly parentId: TaskId | null;
  readonly threadId: ThreadId | null;
  readonly brief: string;
  readonly dependsOn: ReadonlyArray<TaskId>;
  readonly createdAt: string;
}

/**
 * Who retried or reassigned a Task, when it was not you through your controls (#1446): its lead,
 * with the reason it gave, which the change journals with it.
 */
export interface ControlledBy {
  readonly actor: Actor;
  readonly reason: string;
  /** On a reassign, the member's authority worked out again for the hob that takes the Task over. */
  readonly authority?: DelegationAuthority;
}

/** The brief a lead gives a member, for a child Task with another owner. Its Quest, lead and member follow from the Tasks. */
export interface NewDelegation {
  readonly id: DelegationId;
  readonly brief: string;
  readonly expectedOutput: string | null;
  readonly authority: DelegationAuthority;
  readonly timeoutMs: number | null;
}

export interface NewMilestone {
  readonly id: MilestoneId;
  readonly title: string;
}

export interface NewQuest {
  readonly id: QuestId;
  readonly taskId: TaskId;
  readonly goal: string;
  readonly acceptance: ReadonlyArray<string>;
  /**
   * The acceptance as criteria (#1445), one for each line of `acceptance`, in order. Absent, each
   * line is a required criterion with an id of the hub's.
   */
  readonly criteria?: ReadonlyArray<NewCriterion>;
  readonly limits: QuestLimits;
  readonly createdAt: string;
}

export interface NewCriterion {
  readonly id: CriterionId;
  readonly text: string;
  readonly required: boolean;
}

/**
 * Evidence a Quest's lead names for a criterion (#1445): an artifact a Task in the Quest returned,
 * by its id, or a file a Task in the Quest made or changed, by its absolute path. The records tie
 * it to that artifact's version.
 */
export type EvidenceClaim =
  | { readonly _tag: "Returned"; readonly artifactId: ArtifactId }
  | { readonly _tag: "File"; readonly path: string };

/** A check of one acceptance criterion (#1445), by whom, why and when. */
export type CriterionCheck = { readonly by: Actor; readonly reason: string; readonly at: string } & (
  | { readonly _tag: "Accept"; readonly evidence: ReadonlyArray<EvidenceClaim> }
  | { readonly _tag: "Rework" }
  | { readonly _tag: "Waive" }
);

/** A lead's ask that you waive a required criterion (#1445): the question the hub puts to you. */
export interface WaiverRequest {
  readonly questionId: QuestionId;
  /** The Quest's lead, who asks. */
  readonly askerId: AgentId;
  readonly reason: string;
  readonly at: string;
}

export interface NewAttempt {
  readonly id: AttemptId;
  readonly runtime: RuntimeKind;
  readonly sessionId: string | null;
  readonly configVersion: number;
  readonly policyVersion: string | null;
  readonly startedAt: string;
}

/**
 * What happened to a live Attempt: the runtime took it in its session, or it ended, and why. The
 * record decides the state it ends in from why and its Task (`AttemptTransitions.end`). A
 * `policyVersion` is the one its first turn's tools ran under: an Attempt keeps the first it is given.
 * A `reply` is the final reply of the turn that ended it, which the record journals and does not keep.
 */
export type AttemptChange =
  | { readonly _tag: "Running"; readonly sessionId?: string; readonly policyVersion?: string; readonly at: string }
  | {
      readonly _tag: "Ended";
      readonly end: AttemptEnd;
      readonly sessionId?: string;
      readonly policyVersion?: string;
      readonly reply?: string;
      readonly at: string;
    };

/** The turn that resumes a Task's Attempt: when, and the brain and configuration it runs on. */
export interface AttemptResume {
  readonly runtime: RuntimeKind;
  readonly configVersion: number;
  readonly at: string;
}

export interface NewArtifact {
  readonly id: ArtifactId;
  readonly kind: ArtifactKind;
  readonly label: string;
  readonly value: string;
}

/** A Task's result: a summary, the Attempt that produced it and the artifacts it made. */
export interface TaskCompletion {
  readonly summary: string;
  readonly attemptId: AttemptId;
  readonly artifacts: ReadonlyArray<NewArtifact>;
  readonly at: string;
  /**
   * The backpack items the completing turn carries (ADR 019). The gate leaves them out, and the
   * completion resolves them as consumed; any other open item still blocks it. None by default.
   */
  readonly carried?: ReadonlyArray<CarriedItem>;
  /**
   * What the Task changed in a Git repository and left uncommitted (#586), recorded as an automatic
   * `uncommitted` checkpoint with the completion, so the Task's Summary keeps it. None by default.
   */
  readonly uncommitted?: { readonly id: CheckpointId; readonly summary: string };
}

/**
 * A checkpoint its owner reports, or a finding the hub makes itself. The automatic states are
 * recorded by the repository with the state they follow.
 */
export interface NewCheckpoint {
  readonly id: CheckpointId;
  readonly taskId: TaskId;
  readonly source: CheckpointSource;
  readonly kind: CheckpointKind;
  readonly milestoneId: MilestoneId | null;
  /** For a milestone, the hob whose work reached it when that is not the Task's owner (#743). */
  readonly reachedBy?: AgentId | null;
  readonly summary: string;
  /** More about it than the summary holds, for the Workbench, or null. */
  readonly detail?: string | null;
  /** Another Task the checkpoint is also about, as for a hub finding on two Tasks changing one file. */
  readonly aboutTaskId?: TaskId | null;
  readonly createdAt: string;
}

export interface NewQuestion {
  readonly id: QuestionId;
  readonly taskId: TaskId;
  readonly askerId: AgentId;
  readonly text: string;
  readonly createdAt: string;
  /** The choices it offers (#740), and the index of the one its asker recommends. */
  readonly options?: ReadonlyArray<QuestionOption>;
  readonly recommended?: number | null;
}

/** A note you leave on a Task; its id is the command's idempotency key. */
export interface NewNote {
  readonly id: NoteId;
  readonly taskId: TaskId;
  readonly text: string;
  readonly createdAt: string;
  /**
   * The lead sending it to the owner of a Task directly under its own (#574). Absent for your note,
   * which goes to the Task's nearest lead.
   */
  readonly senderId?: AgentId;
  /** The chat message of yours whose turn sends a lead's note (#900). */
  readonly messageId?: MessageId;
  /**
   * The backpack items the sending turn carries. A lead's note sent with no message of yours traces
   * back through the latest note among them that it picked up, as a nested lead passes one on.
   */
  readonly carried?: ReadonlyArray<BackpackItemId>;
  /** How it reaches a turn of its recipient's that runs as it arrives (#1345); the next turn when absent. */
  readonly delivery?: NoteDelivery;
  /**
   * Who wrote it (STD-ARCH-019): a person through their session, the sending lead, or the hub. Absent,
   * the sending lead, or the session's person for a note with no sender.
   */
  readonly author?: Actor;
  /**
   * Yours, straight to the Task's own owner rather than its nearest lead (#1446): an @mention of a
   * member in a quest. Its lead is not woken for it.
   */
  readonly direct?: true;
}

/** A question that climbed every lead and waits for you, with the Task it asks about. */
export interface WaitingQuestion {
  readonly question: Question;
  readonly task: Task;
}

/** What a Task's owner waits for. */
export interface NewWait {
  readonly on: ReadonlyArray<TaskId>;
  readonly mode: WaitMode;
  readonly at: string;
  /**
   * Leaves an active Task active, because the turn that records the wait still runs. The turn's end
   * shows it waiting.
   */
  readonly keepActive?: boolean;
}

type Changed<A, E = TaskRefused> = Effect.Effect<Committed<A>, E>;
type TaskChange = TaskRefused | StaleTask | IllegalTaskTransition;

/**
 * The durable records of ADR 018. Every write checks lineage and invariants, and is journaled with
 * its events in one transaction; a refused write changes nothing. Changes to a Task name the
 * revision they were decided on, and a stale one is refused (EX-002).
 */
/** How a move is made, beyond where it goes. */
export interface TaskMoveOptions {
  /** The backpack items the turn that ended read, which a move to `blocked` settles. */
  readonly carried?: ReadonlyArray<CarriedItem>;
  /** Who asked for a cancel this move makes: the hob that cancelled the Task, or you. */
  readonly cancelledBy?: AgentId | "you";
  /**
   * Why the hub moves the Task to blocked or failed: recorded as a blocker on it in the same change,
   * so its lead gets one Failure item that says why, not a blocker and a Failure (#683).
   */
  readonly reason?: string;
}

/**
 * One turn of an Attempt outside any chat, a planned step's or a party member's, whose usage Usage
 * counts (#1011). A chat turn's usage stays on its reply.
 */
export interface AttemptTurn {
  readonly attemptId: AttemptId;
  /** The hob that runs the turn, and the runtime and model it runs on. */
  readonly agentId: AgentId;
  readonly runtime: RuntimeKind;
  readonly model: string | null;
  /** When the turn started (ISO 8601), which names it on its Attempt and which Usage counts it by. */
  readonly startedAt: string;
}

export class TaskRepository extends Context.Service<
  TaskRepository,
  {
    /** Creates a Task, a step (a child with its parent's owner) or a member's Task with its Delegation. */
    readonly createTask: (input: {
      readonly task: NewTask;
      readonly delegation: NewDelegation | null;
      readonly milestones: ReadonlyArray<NewMilestone>;
    }) => Changed<Task>;
    /** Adds a Quest to a Task; its owner becomes the lead. */
    readonly startQuest: (input: NewQuest) => Changed<Quest>;
    /**
     * Records that a Quest's lead stopped it at your request (#1346), with its reason and summary,
     * from the Quest's version `revision`. The Quest is stopping until its Task's cancel is
     * confirmed, and then ends stopped. Refused for a Quest that is not under way, or that changed.
     */
    readonly stopQuest: (
      questId: QuestId,
      revision: number,
      stop: { readonly reason: string; readonly summary: string; readonly at: string },
    ) => Changed<Quest>;
    /**
     * Checks one of a Quest's acceptance criteria (#1445): accepts it on evidence, tied to each
     * artifact's latest version, sends it back for rework, or waives it. Refused for a criterion the
     * Quest does not have, a check its state or rules do not allow (only you waive a required one),
     * evidence that is no artifact of the Quest's Tasks, or one a newer version replaced.
     */
    readonly checkCriterion: (questId: QuestId, criterionId: CriterionId, check: CriterionCheck) => Changed<Quest>;
    /**
     * Asks you whether to waive a required criterion (#1445): a question to you about the Quest's top
     * Task, with the choices "Waive it" and "Keep it". Your "Waive it" waives it as yours; any other
     * answer leaves it as it is. Refused for an optional or waived criterion, an ended Quest, and while
     * an earlier ask about it is still open.
     */
    readonly askToWaive: (
      questId: QuestId,
      criterionId: CriterionId,
      request: WaiverRequest,
    ) => Changed<{ readonly quest: Quest; readonly question: Question }>;
    /** Links a Task to criteria of its Quest that it works towards (#1445). Refused for an unknown criterion. */
    readonly linkCriteria: (
      questId: QuestId,
      criterionIds: ReadonlyArray<CriterionId>,
      taskId: TaskId,
    ) => Changed<Quest>;
    /**
     * Starts the Task's next Attempt: its first, a resume or a retry. Never a new Task (EX-001). A
     * retry needs every Task above to be open, and reopens the Task's Quest.
     */
    readonly startAttempt: (
      taskId: TaskId,
      revision: number,
      attempt: NewAttempt,
    ) => Changed<{ readonly task: Task; readonly attempt: Attempt }, TaskChange>;
    /**
     * Records that a live Attempt is running or has ended. It ends in the state its end and its
     * Task call for, read in the same transaction, so one whose Task is being cancelled ends
     * cancelled. The Task's own state is decided separately, so an Attempt still ends after its
     * Task completed or failed.
     */
    readonly updateAttempt: (
      attemptId: AttemptId,
      change: AttemptChange,
    ) => Changed<{ readonly task: Task; readonly attempt: Attempt }>;
    /**
     * Puts the Task's current Attempt, once it has ended, back to starting for another turn of the
     * same work, as a lead's next chat turn or a member's next turn on its Task does: the Attempt
     * keeps its number, and only a retry or a reassignment starts a new one. Refused for a Task that
     * has ended, is being cancelled or waits queued after a retry, for an Attempt that is live, was cancelled or never confirmed its stop, and for one
     * that ran on another brain or configuration, which starts an Attempt of its own instead.
     */
    readonly resumeAttempt: (
      taskId: TaskId,
      revision: number,
      resume: AttemptResume,
    ) => Changed<{ readonly task: Task; readonly attempt: Attempt }, TaskChange>;
    /**
     * Moves a Task to another state. It fails or is cancelled only once its Attempt and every Task
     * under it have ended, and ends its Quest with it. A move to `blocked` settles the backpack items
     * in `carried`, those the turn that ended read, as a completion settles them; other moves ignore
     * them. A move that asks for a cancel records who asked (`cancelledBy`), which an Attempt the
     * cancel stops names (#669, #674).
     */
    readonly moveTask: (
      taskId: TaskId,
      revision: number,
      to: TaskTarget,
      at: string,
      options?: TaskMoveOptions,
    ) => Changed<Task, TaskChange>;
    /**
     * Completes a Task with a result from its current Attempt once its responsibility ledger is
     * settled, less what the completing turn carries; completes its Quest with it. Refused otherwise,
     * naming the first eight open entries and counting the rest (IN-006).
     */
    readonly completeTask: (taskId: TaskId, revision: number, completion: TaskCompletion) => Changed<Task, TaskChange>;
    /**
     * Queues a failed Task again for its owner, as a new Attempt of the same Task (EX-001). Only a
     * Task under another one is retried, under ancestors still open and not being cancelled; its
     * Quest reopens with it.
     */
    readonly retryTask: (taskId: TaskId, revision: number, at: string, by?: ControlledBy) => Changed<Task, TaskChange>;
    /**
     * Gives a party member's Task to another hob, queued for its first Attempt there, keeping its
     * id, Attempts, checkpoints and results (ADR 018). Refused while its Attempt is live or work is
     * open under it, when it holds a Quest of its own, and for a hob that already owns a Task on its
     * way up, the lead included.
     */
    readonly reassignTask: (
      taskId: TaskId,
      revision: number,
      ownerId: AgentId,
      at: string,
      by?: ControlledBy,
    ) => Changed<Task, TaskChange>;
    /**
     * Pauses a Task you asked to pause (#1446), from its version `revision`: `pausing` while its
     * Attempt runs, which ends paused once that turn ends, and `paused` otherwise. The Quest on it,
     * if any, is paused with it. Refused for a Task that cannot be paused now, or that changed.
     */
    readonly pauseTask: (
      taskId: TaskId,
      revision: number,
      pause: { readonly at: string; readonly by: Actor; readonly now: boolean },
    ) => Changed<Task, TaskChange>;
    /**
     * The turn a pause waited for ended (#1446): the Task is paused now, and goes back to
     * `otherwise` on Resume unless that turn moved it on itself.
     */
    readonly settlePause: (
      taskId: TaskId,
      revision: number,
      otherwise: PausedFrom,
      at: string,
    ) => Changed<Task, TaskChange>;
    /**
     * Resumes a Task you paused (#1446), back where its pause says it stood, with the Quest on it.
     * Refused while a Task above it is still paused.
     */
    readonly resumeTask: (
      taskId: TaskId,
      revision: number,
      resume: { readonly at: string; readonly by: Actor },
    ) => Changed<Task, TaskChange>;
    /** Tasks still pausing: each waits for its turn to end, or, after a restart, for nothing (#1446). */
    readonly listPausingTasks: Effect.Effect<ReadonlyArray<Task>>;
    readonly recordCheckpoint: (input: NewCheckpoint) => Changed<Checkpoint>;
    /** Asks the nearest lead above the Task, or the user when there is none. */
    readonly askQuestion: (input: NewQuestion) => Changed<Question>;
    /** `from` is the device and surface you answered on, for your own answer (#671). */
    readonly answerQuestion: (
      questionId: QuestionId,
      by: Answerer,
      answer: string,
      at: string,
      from?: {
        readonly deviceId: DeviceId;
        readonly via: QuestionSurface | null;
        /** The person who answered, from their session (STD-SEC-006): a waiver they choose names them. */
        readonly actor?: Actor;
      },
    ) => Changed<Question>;
    /** Passes a question from its current lead to the next lead up, or to the user from the top lead. */
    readonly escalateQuestion: (questionId: QuestionId, by: AgentId) => Changed<Question>;
    /**
     * Records your note on a Task for its nearest lead, or for its owner when nobody leads it
     * (ADR 018). A Task that ended takes one while the work it is part of goes on; once its top Task
     * has ended, nobody is left to read it, and it is refused. Leaving a note with the same id again
     * returns the first and changes nothing; the same id with another Task or text is refused.
     */
    readonly leaveNote: (input: NewNote) => Changed<TaskNote>;
    /** The questions no lead could answer that wait for you, oldest first. */
    readonly listWaitingQuestions: Effect.Effect<ReadonlyArray<WaitingQuestion>>;
    /** Members' failed Tasks that wait on you while their top Task goes on, oldest first (ADR 027). */
    readonly listFailedTasks: Effect.Effect<ReadonlyArray<FailedTask>>;
    /**
     * How Quests are going, as the hub last published each (ADR 037): every Quest followed in
     * `threadId`, ended ones included, or with none every Quest still active. Oldest Quest first.
     */
    readonly listQuestSummaries: (threadId: ThreadId | null) => Effect.Effect<ReadonlyArray<QuestSummary>>;
    /** Gives an artifact to another Task in its tree. Handing it to the same Task again changes nothing. */
    readonly handOff: (artifactId: ArtifactId, toTaskId: TaskId, at: string) => Changed<HandOff>;
    /**
     * Records that the Task's owner waits for Tasks under it, replacing any earlier wait, and shows
     * the Task as waiting, unless `keepActive` keeps it active while its turn runs.
     */
    readonly waitFor: (
      taskId: TaskId,
      revision: number,
      wait: NewWait,
    ) => Changed<{ readonly task: Task; readonly wait: TaskWait }, TaskChange>;
    /**
     * Records, once its runtime took it, a turn of an Attempt outside any chat (#1011), before it has
     * used anything, so a turn the hub never saw end still counts, as unreported, once its Attempt
     * ends. An earlier turn of the Attempt still open ends here, since only one turn runs at a time.
     * Recording it again changes nothing.
     */
    readonly startTurn: (turn: AttemptTurn) => Effect.Effect<void>;
    /**
     * Records the read-the-web mark of the session an Attempt runs in (ADR 036): it keeps when its
     * session first read the web, and takes the source the mark names now, with its journal event
     * so a Workbench already open shows it. None when the Attempt does not exist or already holds it.
     */
    readonly markAttemptReadWeb: (
      attemptId: AttemptId,
      mark: WebReadMark,
    ) => Effect.Effect<Option.Option<Committed<Attempt>>>;
    /** Records what the turn used, once it ends; null when its runtime reported nothing. */
    readonly endTurn: (
      turn: Pick<AttemptTurn, "attemptId" | "startedAt">,
      usage: ReplyUsage | null,
      endedAt: string,
    ) => Effect.Effect<void>;
    /** What still keeps the Task open, as its completion gate reads it (ADR 019). */
    readonly readLedger: (taskId: TaskId) => Effect.Effect<Option.Option<ResponsibilityLedger>>;
    /** The Task and everything under it. */
    readonly readTree: (taskId: TaskId) => Effect.Effect<Option.Option<TaskTree>>;
    /** The tree of each Task a request in the thread started, oldest first. */
    readonly readThreadTrees: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<TaskTree>>;
    readonly findQuest: (questId: QuestId) => Effect.Effect<Option.Option<Quest>>;
    /** How many Tasks the hob owns that have not ended, across every tree. */
    readonly openTaskCount: (ownerId: AgentId) => Effect.Effect<number>;
    /** The Tasks the hob owns that have not ended, across every tree, oldest first. */
    readonly listOpenTasks: (ownerId: AgentId) => Effect.Effect<ReadonlyArray<Task>>;
    /**
     * Why the Task could not go to `ownerId` once its running turn stopped, by Reassign's rules, or
     * null when it could (#408). Writes nothing.
     */
    readonly handOverRefusal: (taskId: TaskId, ownerId: AgentId) => Effect.Effect<TaskRefused | null>;
    /**
     * A hob's Tasks as a party member on Quests still active, oldest first. A member's Task stays
     * listed once it ends, until its Quest does, so its outcome shows where its work did.
     */
    readonly listMemberWork: (agentId: AgentId) => Effect.Effect<ReadonlyArray<MemberWork>>;
    /** The records a hob's History is read from, its party's work included when it leads (ADR 018). */
    readonly readHistoryRecords: (agentId: AgentId) => Effect.Effect<HistoryRecords>;
    /**
     * Steps waiting to start, oldest first: queued Tasks whose parent has the same owner and has not
     * ended. Whether their dependencies have completed is for the caller to check.
     */
    readonly listQueuedSteps: Effect.Effect<ReadonlyArray<Task>>;
    /**
     * Steps that started and have not ended, whose Attempt has ended, oldest first: Hobbots
     * stopped while they ran, or between ending a step's session and ending the step, so nothing
     * will end them on their own.
     */
    readonly listStrandedSteps: Effect.Effect<ReadonlyArray<Task>>;
    /** Tasks whose cancel was asked for and is not confirmed yet, oldest first. */
    readonly listCancellingTasks: Effect.Effect<ReadonlyArray<Task>>;
    /** Every Attempt still starting or running, oldest first: after a restart, none of them runs. */
    readonly listLiveAttempts: Effect.Effect<ReadonlyArray<Attempt>>;
    /** The top Tasks of work that has not ended where a Task has an Attempt, for the hub to look over again. */
    readonly listRootsAtWork: Effect.Effect<ReadonlyArray<TaskId>>;
  }
>()("@hobbots/agents/TaskRepository") {}

/**
 * The work a tool call's key belongs to (#660): the Task the turn works on when it starts, or, for a
 * chat turn that starts on none, its reply, which its retries and Continue share. A key is unique per
 * hob within one scope, so a key chosen for one Task is free again for the next, while a turn
 * delivered again on the same Task still finds the calls the first delivery made.
 */
export const callScope = {
  reply: (messageId: string) => `reply:${messageId}`,
  task: (taskId: string) => `task:${taskId}`,
};

/** A hob's call to a Task tool, as the ledger keys it: by hob, scope and key, with the input it carried. */
export interface TaskToolCall {
  readonly agentId: AgentId;
  /** The work the key belongs to, from `callScope`. */
  readonly scope: string;
  /**
   * Another scope a retry of the key is found in: a chat turn's reply, so Continue on a reply whose
   * first run started its Task still finds what that run did under the reply's scope.
   */
  readonly also?: string;
  readonly key: string;
  readonly tool: TaskToolName;
  /**
   * The input without its key, with the Task the turn works on, as stable JSON: a key sent again
   * for another call, or from another Task, is told apart.
   */
  readonly input: string;
  readonly at: string;
  /**
   * The backpack claims the calling turn holds (ADR 019). The call is fenced by them: when any of
   * them no longer holds, by owner, token and lease, it writes nothing and is refused. An item the
   * turn carries without a claim, with no owner, fences nothing.
   */
  readonly fence?: ReadonlyArray<CarriedItem>;
}

/** What a call did, and the journal entries to announce; none when it was a retry. */
export interface TaskToolOutcome {
  readonly done: TaskToolDone;
  readonly entries: ReadonlyArray<EventEnvelope>;
  /**
   * The work the call started, when it started the turn's Task (#660): the call, and every call
   * and Charm write its turn made before in the call's scope, move into it, so a later reply on the
   * Task finds them.
   */
  readonly scope?: string;
  /**
   * The backpack items the call's result tells the turn, as a result or failure it shows (#662).
   * The turn carries them from then on, as it carries what its prompt shows. None by default.
   */
  readonly shown?: ReadonlyArray<CarriedItem>;
}

/** A Task tool call the hub refused, to record (#575). */
export interface RefusedTaskToolCall {
  readonly agentId: AgentId;
  /** The work the key belongs to, from `callScope`. */
  readonly scope: string;
  /** The key the call came with; null when it came with none the hub could read. */
  readonly key: string | null;
  /** The tool's name as the call gave it, which may name no tool. */
  readonly tool: string;
  /** The call's input as stable JSON. */
  readonly input: string;
  /** The Task the calling turn worked on, when the hub knew it. */
  readonly taskId: TaskId | null;
  readonly refused: TaskToolRefused;
  readonly at: string;
}

/**
 * Makes each Task tool call happen once per hob, scope and key (ADR 018, #660). The call's writes and its
 * result are stored in one transaction, so a retried call returns the first result and never
 * writes again; a refused call writes nothing, its key stays free, and a retry is decided again.
 * A call from a turn whose backpack claim no longer holds is refused in that same transaction, as
 * `claim-stale` (ADR 019).
 *
 * Every refusal is recorded apart from the calls that were done, with its code and message, and
 * journaled, so the user and an audit can see it (#575). A call retried with its key and refused
 * again is the same record, with one more try.
 */
export class TaskToolCalls extends Context.Service<
  TaskToolCalls,
  {
    readonly once: <E>(
      call: TaskToolCall,
      run: Effect.Effect<TaskToolOutcome, E>,
    ) => Effect.Effect<TaskToolOutcome, E | TaskToolRefused>;
    /** Records a refused call, and journals it. */
    readonly refused: (call: RefusedTaskToolCall) => Effect.Effect<Committed<RefusedCall>>;
  }
>()("@hobbots/agents/TaskToolCalls") {}
