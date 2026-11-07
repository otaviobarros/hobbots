import { Effect, Schema } from "effect";
import { ApprovalRequest } from "./approval.ts";
import { DeviceId } from "./device.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { StoredPolicyLayer } from "./policy.ts";
import { Revision } from "./revision.ts";
import { Attempt, AttemptId, isLiveAttempt, isTerminalTask, Task, TaskId } from "./task.ts";

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
  /**
   * The folders its work is in, as the hub stores them: its lead's turns on it track only its own
   * folders that hold or sit in one of these (#670). Absent, all of the lead's folders.
   */
  folders: Schema.optionalKey(Schema.Array(Schema.String)),
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
  overrides: StoredPolicyLayer,
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
  /**
   * The hob whose work reached it (#743): the Task's owner that reported it, or the hob it named as
   * having done the work, such as its lead making a commit the owner could not. Null while it is not
   * reached, and in milestones journaled before migration 0074.
   */
  reachedBy: Schema.NullOr(AgentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  createdAt: Schema.String,
}) {}

/**
 * Planned milestones and unplanned reports come from the Task's owner; automatic states, the
 * findings the hub notices itself, such as two Tasks changing the same file, and the reason the hub
 * gives when it blocks or fails a Task, from the hub.
 */
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
  "uncommitted",
]);
export type CheckpointKind = typeof CheckpointKind.Type;

/** The kinds each source records. */
export const CHECKPOINT_KINDS: Record<CheckpointSource, ReadonlyArray<CheckpointKind>> = {
  planned: ["milestone"],
  unplanned: ["finding", "blocker", "question", "progress"],
  automatic: ["started", "waiting", "done", "failed", "cancelled", "finding", "blocker", "uncommitted"],
};

type CheckpointOf = { readonly source: CheckpointSource; readonly kind: CheckpointKind };

/**
 * Whether a checkpoint says more than its Task's state: anything its owner reported, a finding or
 * blocker the hub recorded, or the changes it left uncommitted when it completed.
 */
export const saysMore = (checkpoint: CheckpointOf) =>
  reportsOn(checkpoint) || checkpoint.kind === "finding" || checkpoint.kind === "uncommitted";

/** Whether a checkpoint reports on its Task: its owner's report, or the reason the hub blocked or failed it. */
export const reportsOn = (checkpoint: CheckpointOf) =>
  checkpoint.source !== "automatic" || checkpoint.kind === "blocker";

/** Whether a checkpoint of this kind reaches the lead's context and can wake it; routine progress never does (IN-005). */
export const wakesLead = (kind: CheckpointKind): boolean =>
  kind !== "progress" && kind !== "started" && kind !== "waiting" && kind !== "cancelled";

/**
 * How the hub's finding starts when a turn of the Task you asked for left its Quest with nothing
 * moving it: no Task open under it and nothing to wait on (#1081). It goes to the Quest's own lead,
 * so its chat wakes with what is missing.
 */
export const IDLE_QUEST = "Nobody is working on this Quest";

/** Whether a checkpoint is the hub's finding that a Quest has nothing moving it (#1081). */
export const isIdleQuestFinding = (checkpoint: CheckpointOf & { readonly summary: string }): boolean =>
  checkpoint.source === "automatic" && checkpoint.kind === "finding" && checkpoint.summary.startsWith(IDLE_QUEST);

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
  /** Where the Task stands, in a few words: the beat a lane shows. */
  summary: Schema.String,
  /**
   * More about it, when its owner had more to say: the Workbench shows it, a lane never does (#901).
   * Null when there is none, and for every checkpoint journaled before migration 0052.
   */
  detail: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * Another Task the checkpoint is also about, or null: for a finding the hub made because two
   * Tasks changed the same file, the Task that changed it first, so both Tasks show it. Checkpoints
   * journaled before migration 0041 carry none.
   */
  aboutTaskId: Schema.NullOr(TaskId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  createdAt: Schema.String,
  /** The journal sequence it was recorded at, which orders checkpoints that share a time. */
  revision: Revision,
}) {}

/** Longest detail a lead's context keeps from one checkpoint, so its own context stays small. */
export const DETAIL_LIMIT = 600;

/** A checkpoint's detail, cut to `limit` characters and marked when cut, or null when it has none. */
export const detailOf = (checkpoint: Checkpoint, limit = DETAIL_LIMIT): string | null => {
  const detail = checkpoint.detail?.trim() ?? "";
  if (detail === "") return null;
  return detail.length <= limit ? detail : `${detail.slice(0, limit).trimEnd()}…`;
};

/**
 * What a lead's context says of a checkpoint (#901): its short summary, then its detail, bounded, so
 * what the hob put beyond the beat a lane shows still reaches the lead.
 */
export const checkpointText = (checkpoint: Checkpoint, limit = DETAIL_LIMIT): string => {
  const detail = detailOf(checkpoint, limit);
  return detail === null ? checkpoint.summary : `${checkpoint.summary}. Detail: ${detail}`;
};

/** Whether a checkpoint belongs on `taskId`'s card: recorded on it, or about it too. */
export const checkpointOn = (checkpoint: Checkpoint, taskId: TaskId) =>
  checkpoint.taskId === taskId || checkpoint.aboutTaskId === taskId;

/** A question is open until it is answered, or withdrawn when its Task ends first and nobody is left to hear the answer. */
export const QuestionState = Schema.Literals(["open", "answered", "withdrawn"]);
export type QuestionState = typeof QuestionState.Type;

/** Who answered a question: a lead, or the user. */
export const Answerer = Schema.Union([
  Schema.TaggedStruct("Lead", { agentId: AgentId }),
  Schema.TaggedStruct("User", {}),
]);
export type Answerer = typeof Answerer.Type;

/** Where you answered a question: its card in the chat, the Inbox, or the Task's drawer or sheet (#671). */
export const QuestionSurface = Schema.Literals(["chat", "inbox", "task"]);
export type QuestionSurface = typeof QuestionSurface.Type;

/** Most choices a question offers (#740): two to four, as a card shows them as buttons. */
export const MAX_QUESTION_OPTIONS = 4;

/** One choice a question offers (#740): a short label, and one line on what happens if it is picked. */
export const QuestionOption = Schema.Struct({
  label: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(80)),
  consequence: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(200)),
});
export type QuestionOption = typeof QuestionOption.Type;

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
  /**
   * The approved device you answered it from (#671); null while open, for a lead's answer, and for
   * questions answered before this was recorded.
   */
  answeredByDeviceId: Schema.NullOr(DeviceId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Where you answered it; null also when the client did not say. */
  answeredVia: Schema.NullOr(QuestionSurface).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The choices it offers, none for a question answered in words only (#740). */
  options: Schema.Array(QuestionOption).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /** The index in `options` of the one the asker recommends, if any. */
  recommended: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Once answered, the index in `options` of the choice picked; null when the answer was typed. */
  picked: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  revision: Revision,
}) {}

/** The choice an answered question's answer picked, or undefined for a typed answer. */
export const pickedOption = (question: Pick<Question, "options" | "picked">): QuestionOption | undefined =>
  question.picked === null ? undefined : question.options[question.picked];

/**
 * A question's choices as a hob reads them, after the question, or "" for one without:
 * ` Choices: 1. Light (recommended): matches the brand; 2. Dark: stands out.`
 */
export const choicesText = (question: Question): string =>
  question.options.length === 0
    ? ""
    : ` Choices: ${question.options
        .map((option, index) => {
          const mark = index === question.recommended ? " (recommended)" : "";
          const line = option.consequence === "" ? "" : `: ${option.consequence}`;
          return `${index + 1}. ${option.label}${mark}${line}`;
        })
        .join("; ")}`;

/** How an answered question with choices was answered, as its asker hears it, or "" for one without. */
export const answerHow = (question: Question): string =>
  question.options.length === 0
    ? ""
    : question.picked === null
      ? " (written in words, not one of the choices)"
      : ` (choice ${question.picked + 1} of ${question.options.length})`;

/**
 * A label two of `options` share once case is ignored, or undefined when each is its own (#740):
 * an answer names its choice by label, so two that read the same could not be told apart.
 */
export const collidingLabel = (options: ReadonlyArray<{ readonly label: string }>): string | undefined => {
  const seen = new Set<string>();
  for (const option of options) {
    const key = option.label.trim().toLowerCase();
    if (seen.has(key)) return option.label;
    seen.add(key);
  }
  return undefined;
};

/**
 * Why `options` with `recommended` can't be offered, or undefined when they can (#740): each label
 * reads differently once case is ignored, and `recommended` points at one of them. A hob counts
 * its choices from 1 and the hub from 0 (#976), so `from` says which.
 */
export const choicesProblem = (
  options: ReadonlyArray<{ readonly label: string }> | undefined,
  recommended: number | undefined,
  from: 0 | 1,
): string | undefined => {
  const same = options === undefined ? undefined : collidingLabel(options);
  if (same !== undefined) return `Two options are both "${same}". Give each option its own label.`;
  if (recommended === undefined) return undefined;
  if (options === undefined) return "recommended needs options to recommend one of.";
  if (recommended - from < options.length) return undefined;
  return from === 1
    ? `recommended is the number of one of the ${options.length} options.`
    : `recommended is the index of one of the ${options.length} options, from 0.`;
};

/**
 * The index of the choice `answer` names, ignoring case and surrounding spaces, or null when it
 * names none: a lead that answers in words with a choice's label picked that choice.
 */
export const optionNamed = (options: ReadonlyArray<QuestionOption>, answer: string): number | null => {
  const wanted = answer.trim().toLowerCase();
  const index = options.findIndex((option) => option.label.toLowerCase() === wanted);
  return index === -1 ? null : index;
};

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
  /** The lead that sent it to its member's Task (#574); absent or null for a note you left. */
  senderId: Schema.optionalKey(Schema.NullOr(AgentId)),
  text: Schema.String,
  createdAt: Schema.String,
  /**
   * The chat message of yours it traces back to (#900): the one whose turn sent it, or, for a nested
   * lead's note, that of the latest note from its own lead its turn picked up (`fromNoteId`). Null for a note you left on a Task, and for one a lead
   * sent on its own, or before this was recorded.
   */
  messageId: Schema.NullOr(MessageId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The note its sender's turn picked up and passed on, when a nested lead sent it; null otherwise. */
  fromNoteId: Schema.NullOr(NoteId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * The turn of its recipient that picked it up last: a reply's message id or an Attempt's id, once
   * the backpack put it into that turn and the runtime accepted the turn (ADR 019). Null until a
   * turn did; see `noteReceipt` for what it waits on.
   */
  pickedUpBy: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  pickedUpAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
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
  "parent-cancelling",
  "task-cancelling",
  "top-task",
  "not-delegated",
  "same-owner",
  "lineage-owner",
  "options-collide",
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

export const RefusedCallId = Schema.String.pipe(Schema.brand("RefusedCallId"));
export type RefusedCallId = typeof RefusedCallId.Type;

/**
 * A Task tool call the hub refused (ADR 018), recorded so the user and an audit can see it. A call
 * retried with its key and refused again is the same record, with one more try; a call that came
 * with no usable key, such as one whose input did not decode, is a record of its own. `taskId` is
 * the Task the calling turn worked on, when the hub knew it; `input` is the call's input as stable
 * JSON, cut when long; `reason` is the refusal's code, such as `not-owner`.
 */
export class RefusedCall extends Schema.Class<RefusedCall>("RefusedCall")({
  id: RefusedCallId,
  agentId: AgentId,
  taskId: Schema.NullOr(TaskId),
  tool: Schema.String,
  key: Schema.NullOr(Schema.String),
  input: Schema.String,
  reason: Schema.String,
  message: Schema.String,
  tries: Schema.Int,
  createdAt: Schema.String,
  /** When it was last refused: `createdAt` for a call refused once. */
  refusedAt: Schema.String,
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
  /** The Task tool calls the hub refused for its Tasks, oldest first. */
  refusals: Schema.Array(RefusedCall).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /**
   * The approval requests that pause its Tasks' turns until you decide them (PE-003), oldest first:
   * each Task waits on you while one is pending (#698). The hub reads only pending ones; a client may
   * hold a decided copy until it reads the tree again, so read them through `pendingApprovals`.
   */
  approvals: Schema.Array(ApprovalRequest).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
}) {}

/** The requests anywhere in the tree that wait for you to decide them, oldest first. */
export const pendingApprovals = (tree: TaskTree): ReadonlyArray<ApprovalRequest & { readonly taskId: TaskId }> =>
  tree.approvals.filter(
    (approval): approval is ApprovalRequest & { readonly taskId: TaskId } =>
      approval.state === "pending" && approval.taskId !== null,
  );

/** The requests on Task `taskId` that wait for you to decide them, oldest first: its turn is paused on them. */
export const pendingApprovalsOn = (tree: TaskTree, taskId: TaskId): ReadonlyArray<ApprovalRequest> =>
  pendingApprovals(tree).filter((approval) => approval.taskId === taskId);

/** Whether a turn runs on `task` now: its current Attempt is still starting or running. */
export const liveAttemptOn = (task: Task, tree: TaskTree): boolean =>
  tree.attempts.some((attempt) => attempt.id === task.currentAttemptId && isLiveAttempt(attempt.state));

/**
 * The Tasks whose artifacts were handed to `taskId` in `tree`, once each, in hand-off order: what
 * its work builds on beyond the Tasks it comes after (ADR 018).
 */
export const handedFrom = (tree: TaskTree, taskId: TaskId): ReadonlyArray<TaskId> => [
  ...new Set(
    tree.handOffs.flatMap((handOff) => {
      if (handOff.toTaskId !== taskId) return [];
      const artifact = tree.artifacts.find((each) => each.id === handOff.artifactId);
      return artifact === undefined ? [] : [artifact.taskId];
    }),
  ),
];

/** The latest request asked of the hob in a thread for which `keep` holds, with its tree. `trees` are the thread's, oldest first. */
const lastThreadTask = (
  trees: ReadonlyArray<TaskTree>,
  agentId: AgentId,
  keep: (top: Task) => boolean,
): { readonly top: Task; readonly tree: TaskTree } | undefined =>
  trees
    .flatMap((tree) => {
      const top = tree.tasks[0];
      return top !== undefined && top.ownerId === agentId && keep(top) ? [{ top, tree }] : [];
    })
    .at(-1);

/** The Task a hob's chat turns work on in a thread, with its tree: the latest Task asked of the hob there that has not ended. */
export const openThreadTask = (trees: ReadonlyArray<TaskTree>, agentId: AgentId) =>
  lastThreadTask(trees, agentId, (top) => !isTerminalTask(top.state));

/** The latest Task asked of the hob in a thread, ended or not, with its tree: what it can still read (#666). */
export const latestThreadTask = (trees: ReadonlyArray<TaskTree>, agentId: AgentId) =>
  lastThreadTask(trees, agentId, () => true);

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
