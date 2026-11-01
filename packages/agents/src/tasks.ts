import type {
  AgentId,
  Answerer,
  ArtifactId,
  ArtifactKind,
  Attempt,
  AttemptId,
  AttemptState,
  Checkpoint,
  CheckpointId,
  CheckpointKind,
  Committed,
  DelegationAuthority,
  DelegationId,
  HandOff,
  IllegalTaskTransition,
  MilestoneId,
  Quest,
  QuestId,
  Question,
  QuestionId,
  QuestLimits,
  RuntimeKind,
  StaleTask,
  Task,
  TaskId,
  TaskRefused,
  TaskTarget,
  TaskTree,
  ThreadId,
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
  readonly limits: QuestLimits;
  readonly createdAt: string;
}

export interface NewAttempt {
  readonly id: AttemptId;
  readonly runtime: RuntimeKind;
  readonly sessionId: string | null;
  readonly configVersion: number;
  readonly policyVersion: string | null;
  readonly startedAt: string;
}

/** What happened to a live Attempt: the runtime took it (`running`), or it ended. */
export interface AttemptChange {
  readonly state: Exclude<AttemptState, "starting">;
  readonly sessionId?: string;
  readonly outcome?: string;
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
}

/** A checkpoint its owner reports; automatic ones are recorded by the repository with the state they follow. */
export interface NewCheckpoint {
  readonly id: CheckpointId;
  readonly taskId: TaskId;
  readonly source: "planned" | "unplanned";
  readonly kind: CheckpointKind;
  readonly milestoneId: MilestoneId | null;
  readonly summary: string;
  readonly createdAt: string;
}

export interface NewQuestion {
  readonly id: QuestionId;
  readonly taskId: TaskId;
  readonly askerId: AgentId;
  readonly text: string;
  readonly createdAt: string;
}

type Changed<A, E = TaskRefused> = Effect.Effect<Committed<A>, E>;
type TaskChange = TaskRefused | StaleTask | IllegalTaskTransition;

/**
 * The durable records of ADR 018. Every write checks lineage and invariants, and is journaled with
 * its events in one transaction; a refused write changes nothing. Changes to a Task name the
 * revision they were decided on, and a stale one is refused (EX-002).
 */
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
     * Starts the Task's next Attempt: its first, a resume or a retry. Never a new Task (EX-001). A
     * retry needs every Task above to be open, and reopens the Task's Quest.
     */
    readonly startAttempt: (
      taskId: TaskId,
      revision: number,
      attempt: NewAttempt,
    ) => Changed<{ readonly task: Task; readonly attempt: Attempt }, TaskChange>;
    /**
     * Records that a live Attempt is running or has ended. The Task's own state is decided
     * separately, so an Attempt still ends after its Task completed or failed.
     */
    readonly updateAttempt: (
      attemptId: AttemptId,
      change: AttemptChange,
    ) => Changed<{ readonly task: Task; readonly attempt: Attempt }>;
    /**
     * Moves a Task to another state. It fails or is cancelled only once its Attempt and every Task
     * under it have ended, and ends its Quest with it.
     */
    readonly moveTask: (taskId: TaskId, revision: number, to: TaskTarget, at: string) => Changed<Task, TaskChange>;
    /**
     * Completes a Task with a result from its current Attempt, once its subtree has ended, its
     * dependencies completed and its questions are answered; completes its Quest with it.
     */
    readonly completeTask: (taskId: TaskId, revision: number, completion: TaskCompletion) => Changed<Task, TaskChange>;
    readonly recordCheckpoint: (input: NewCheckpoint) => Changed<Checkpoint>;
    /** Asks the nearest lead above the Task, or the user when there is none. */
    readonly askQuestion: (input: NewQuestion) => Changed<Question>;
    readonly answerQuestion: (questionId: QuestionId, by: Answerer, answer: string, at: string) => Changed<Question>;
    /** Passes a question from its current lead to the next lead up, or to the user from the top lead. */
    readonly escalateQuestion: (questionId: QuestionId, by: AgentId) => Changed<Question>;
    /** Gives an artifact to another Task in its tree. Handing it to the same Task again changes nothing. */
    readonly handOff: (artifactId: ArtifactId, toTaskId: TaskId, at: string) => Changed<HandOff>;
    /** The Task and everything under it. */
    readonly readTree: (taskId: TaskId) => Effect.Effect<Option.Option<TaskTree>>;
    readonly findQuest: (questId: QuestId) => Effect.Effect<Option.Option<Quest>>;
  }
>()("@hobbots/agents/TaskRepository") {}
