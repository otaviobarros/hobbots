import { Schema } from "effect";
import { AgentId, ThreadId } from "./ids.ts";
import { PolicyOverrides } from "./policy.ts";
import { Revision } from "./revision.ts";
import { Attempt, AttemptId, Task, TaskId } from "./task.ts";

/**
 * The records around Tasks in ADR 018: the Quest added to a Task that brings in other hobs, the
 * Delegations to its party, planned Milestones, Checkpoints, Questions and Artifact references.
 */

export const QuestId = Schema.String.pipe(Schema.brand("QuestId"));
export type QuestId = typeof QuestId.Type;
export const DelegationId = Schema.String.pipe(Schema.brand("DelegationId"));
export type DelegationId = typeof DelegationId.Type;
export const MilestoneId = Schema.String.pipe(Schema.brand("MilestoneId"));
export type MilestoneId = typeof MilestoneId.Type;
export const CheckpointId = Schema.String.pipe(Schema.brand("CheckpointId"));
export type CheckpointId = typeof CheckpointId.Type;
export const QuestionId = Schema.String.pipe(Schema.brand("QuestionId"));
export type QuestionId = typeof QuestionId.Type;
export const ArtifactId = Schema.String.pipe(Schema.brand("ArtifactId"));
export type ArtifactId = typeof ArtifactId.Type;
export const NoteId = Schema.String.pipe(Schema.brand("NoteId"));
export type NoteId = typeof NoteId.Type;

/** A Quest ends with the Task it sits on. */
export const QuestState = Schema.Literals(["active", "completed", "failed", "cancelled"]);
export type QuestState = typeof QuestState.Type;

/** How far a Quest may grow: Quests nested inside it count towards `maxDepth` (2 by default), steps never do. */
export const QuestLimits = Schema.Struct({
  maxDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** When its work must be done (ISO 8601), or null for no deadline. */
  deadline: Schema.NullOr(Schema.String),
});
export type QuestLimits = typeof QuestLimits.Type;

export const DEFAULT_QUEST_LIMITS: QuestLimits = { maxDepth: 2, deadline: null };

/** The record a Task gains when its owner first brings in another hob. The Task keeps its id; its owner is the lead. */
export class Quest extends Schema.Class<Quest>("Quest")({
  id: QuestId,
  taskId: TaskId,
  leadId: AgentId,
  /** The Quest it sits in, for a member's own Quest; null for a top Quest. */
  parentQuestId: Schema.NullOr(QuestId),
  /** The thread that started it: its Task's thread. */
  threadId: Schema.NullOr(ThreadId),
  goal: Schema.String,
  /** What has to hold for the Quest to be done. */
  acceptance: Schema.Array(Schema.String),
  limits: QuestLimits,
  /** 1 for a top Quest, one more for each Quest it sits in. */
  depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: QuestState,
  createdAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  revision: Revision,
}) {}

/**
 * The authority a member works with on a delegated Task: overrides that only narrow its own
 * policy, and the folders it may use, or null for its own. A brief can never widen it.
 */
export const DelegationAuthority = Schema.Struct({
  overrides: PolicyOverrides,
  folders: Schema.NullOr(Schema.Array(Schema.String)),
});
export type DelegationAuthority = typeof DelegationAuthority.Type;

/** A lead's brief to a member: the member's Task under the lead's. */
export class Delegation extends Schema.Class<Delegation>("Delegation")({
  id: DelegationId,
  questId: QuestId,
  leadId: AgentId,
  memberId: AgentId,
  parentTaskId: TaskId,
  childTaskId: TaskId,
  brief: Schema.String,
  /** What the lead expects back, if it said. */
  expectedOutput: Schema.NullOr(Schema.String),
  authority: DelegationAuthority,
  /** How long the member has, in milliseconds, or null for the Quest's limits. */
  timeoutMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  createdAt: Schema.String,
}) {}

/** A point the lead plans in a brief, reported by the Task's owner when reached. */
export class Milestone extends Schema.Class<Milestone>("Milestone")({
  id: MilestoneId,
  taskId: TaskId,
  title: Schema.String,
  /** Its place among the Task's milestones, from 0. */
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reachedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
}) {}

/** Planned milestones and unplanned reports come from the Task's owner; automatic states from the hub. */
export const CheckpointSource = Schema.Literals(["planned", "unplanned", "automatic"]);
export type CheckpointSource = typeof CheckpointSource.Type;

export const CheckpointKind = Schema.Literals([
  "milestone",
  "finding",
  "blocker",
  "question",
  "progress",
  "started",
  "waiting",
  "done",
  "failed",
  "cancelled",
]);
export type CheckpointKind = typeof CheckpointKind.Type;

/** The kinds each source records. */
export const CHECKPOINT_KINDS: Record<CheckpointSource, ReadonlyArray<CheckpointKind>> = {
  planned: ["milestone"],
  unplanned: ["finding", "blocker", "question", "progress"],
  automatic: ["started", "waiting", "done", "failed", "cancelled"],
};

/** Whether a checkpoint of this kind reaches the lead's context and can wake it; routine progress never does (IN-005). */
export const wakesLead = (kind: CheckpointKind): boolean =>
  kind !== "progress" && kind !== "started" && kind !== "waiting" && kind !== "cancelled";

/** A short record of where a Task stands. */
export class Checkpoint extends Schema.Class<Checkpoint>("Checkpoint")({
  id: CheckpointId,
  taskId: TaskId,
  /** The Attempt it was recorded in, or null when none was running. */
  attemptId: Schema.NullOr(AttemptId),
  source: CheckpointSource,
  kind: CheckpointKind,
  /** The milestone a `milestone` checkpoint reached. */
  milestoneId: Schema.NullOr(MilestoneId),
  summary: Schema.String,
  createdAt: Schema.String,
  /** The journal sequence it was recorded at, which orders checkpoints that share a time. */
  revision: Revision,
}) {}

export const QuestionState = Schema.Literals(["open", "answered"]);
export type QuestionState = typeof QuestionState.Type;

/** Who answered a question: a lead, or the user. */
export const Answerer = Schema.Union([
  Schema.TaggedStruct("Lead", { agentId: AgentId }),
  Schema.TaggedStruct("User", {}),
]);
export type Answerer = typeof Answerer.Type;

/**
 * A question from a Task's owner. It goes to the nearest lead, and climbs one lead at a time when
 * escalated; `recipientId` is null once it reaches the user. `chain` lists the leads it passed,
 * in order, so the answer goes back down the same way.
 */
export class Question extends Schema.Class<Question>("Question")({
  id: QuestionId,
  taskId: TaskId,
  askerId: AgentId,
  recipientId: Schema.NullOr(AgentId),
  chain: Schema.Array(AgentId),
  text: Schema.String,
  state: QuestionState,
  answer: Schema.NullOr(Schema.String),
  answeredBy: Schema.NullOr(Answerer),
  createdAt: Schema.String,
  answeredAt: Schema.NullOr(Schema.String),
  revision: Revision,
}) {}

/**
 * A note you left on a Task (ADR 018). You talk only to the lead, so it goes to the Task's nearest
 * lead as a message about that Task, or to the Task's own owner when nobody leads it. Its id is the
 * idempotency key of the command that left it, so leaving it again changes nothing.
 */
export class TaskNote extends Schema.Class<TaskNote>("TaskNote")({
  id: NoteId,
  taskId: TaskId,
  /** The hob the note goes to. */
  recipientId: AgentId,
  text: Schema.String,
  createdAt: Schema.String,
  revision: Revision,
}) {}

export const ArtifactKind = Schema.Literals(["file", "link", "text"]);
export type ArtifactKind = typeof ArtifactKind.Type;

/** A file, link or text a Task made: a path, a URL or the text itself. */
export class ArtifactRef extends Schema.Class<ArtifactRef>("ArtifactRef")({
  id: ArtifactId,
  taskId: TaskId,
  attemptId: AttemptId,
  kind: ArtifactKind,
  label: Schema.String,
  value: Schema.String,
  createdAt: Schema.String,
}) {}

/** A lead gave one Task's artifact to another Task in the same tree, as part of its brief. */
export class HandOff extends Schema.Class<HandOff>("HandOff")({
  artifactId: ArtifactId,
  toTaskId: TaskId,
  createdAt: Schema.String,
}) {}

/**
 * Why a change to a Task's records was refused, because it would break their lineage or
 * invariants (ADR 018). Nothing is written.
 */
export const TaskRefusal = Schema.Literals([
  "task-missing",
  "task-ended",
  "attempt-missing",
  "question-missing",
  "artifact-missing",
  "owner-missing",
  "thread-missing",
  "parent-missing",
  "parent-ended",
  "step-owner",
  "delegation-mismatch",
  "quest-missing",
  "quest-exists",
  "dependency-outside-tree",
  "attempt-live",
  "attempt-ended",
  "attempt-mismatch",
  "children-open",
  "dependencies-open",
  "questions-open",
  "milestones-open",
  "approvals-pending",
  "items-open",
  "milestone-mismatch",
  "checkpoint-kind",
  "not-asker",
  "not-recipient",
  "question-answered",
  "artifact-outside-tree",
  "wait-outside-subtree",
  "note-key-reused",
]);
export type TaskRefusal = typeof TaskRefusal.Type;

export class TaskRefused extends Schema.TaggedError<TaskRefused>()("TaskRefused", {
  reason: TaskRefusal,
  message: Schema.String,
}) {}

export const WaitMode = Schema.Literals(["any", "all"]);
export type WaitMode = typeof WaitMode.Type;

/**
 * A Task's owner waits for any or all of the Tasks under it, without blocking its chat. The Task
 * shows as waiting until they end; what wakes the owner is decided by the inbox, not here.
 */
export class TaskWait extends Schema.Class<TaskWait>("TaskWait")({
  taskId: TaskId,
  on: Schema.Array(TaskId),
  mode: WaitMode,
  createdAt: Schema.String,
}) {}

/** A Task and everything under it. */
export class TaskTree extends Schema.Class<TaskTree>("TaskTree")({
  /** The Task asked for first, then its descendants, oldest first. */
  tasks: Schema.Array(Task),
  quests: Schema.Array(Quest),
  delegations: Schema.Array(Delegation),
  attempts: Schema.Array(Attempt),
  milestones: Schema.Array(Milestone),
  checkpoints: Schema.Array(Checkpoint),
  questions: Schema.Array(Question),
  artifacts: Schema.Array(ArtifactRef),
  handOffs: Schema.Array(HandOff),
  /** The notes you left on its Tasks, oldest first. */
  notes: Schema.Array(TaskNote),
  /** The latest wait of each Task in the tree that has one. */
  waits: Schema.Array(TaskWait),
}) {}

/** The hobs a Quest brought in, in the order they joined: its party. */
export const partyOf = (quest: Quest, delegations: ReadonlyArray<Delegation>): ReadonlyArray<AgentId> => [
  ...new Set(delegations.filter((delegation) => delegation.questId === quest.id).map((d) => d.memberId)),
];

/**
 * A party member's Task on another hob's Quest, with the Delegation that brought it in and the
 * Quest it serves. Home and the member's panel show it as "On Aldric's quest", never as a thread.
 */
export class MemberWork extends Schema.Class<MemberWork>("MemberWork")({
  task: Task,
  delegation: Delegation,
  quest: Quest,
  /**
   * The hob whose thread the request came from, where the Quest is followed. A nested Quest's lead
   * is a member, but its thread is still that hob's; null when the Quest has no thread.
   */
  threadAgentId: Schema.NullOr(AgentId),
}) {}
