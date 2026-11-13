import { Schema } from "effect";
import type { ApprovalRequest } from "./approval.ts";
import { type Artifact, ArtifactReviews } from "./artifact.ts";
import { AgentId, type RegisteredArtifactId, ThreadId } from "./ids.ts";
import { isActiveQuest, type Quest, QuestId, type Question, QuestState } from "./quest.ts";
import { Revision } from "./revision.ts";
import { descendantsOf, isCompletedTask, type Task, TaskId, type TaskState } from "./task.ts";

/**
 * How a Quest is going, as the hub publishes it (ADR 037): one projection that the quest pill, the
 * rail and Home read, so no client folds Task states into counts of its own (STD-REACT-028). It is
 * computed in the transaction that changes a Task under the Quest, and journaled only when it
 * changes.
 */

/** How a Task's state reads at a glance: the tone its label and progress segment take. */
export const WorkTone = Schema.Literals(["needs", "working", "waiting", "done", "problem", "idle"]);
export type WorkTone = typeof WorkTone.Type;

export const workTone: Record<TaskState, WorkTone> = {
  queued: "idle",
  active: "working",
  waiting: "waiting",
  blocked: "needs",
  cancelling: "idle",
  completed: "done",
  failed: "problem",
  cancelled: "idle",
};

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** How many Tasks under a Quest's own Task take each tone. */
export const ToneCounts = Schema.Struct({
  needs: Count,
  working: Count,
  waiting: Count,
  done: Count,
  problem: Count,
  idle: Count,
});
export type ToneCounts = typeof ToneCounts.Type;

export class QuestSummary extends Schema.Class<QuestSummary>("QuestSummary")({
  questId: QuestId,
  /** The Task the Quest sits on. */
  taskId: TaskId,
  leadId: AgentId,
  /** The Quest it sits in, for a member's own Quest; null for a top Quest. */
  parentQuestId: Schema.NullOr(QuestId),
  /** The chat or camp the Quest is followed in, which moves with it when a chat starts fresh. */
  threadId: Schema.NullOr(ThreadId),
  state: QuestState,
  /** Every Task under the Quest's own, steps, members' Tasks and nested Quests included, by tone. */
  tones: ToneCounts,
  /**
   * What waits on you while the Quest runs: each question that climbed every lead and each pending
   * approval on its Tasks, its own included, and each Task under it that failed and waits for a retry
   * or another hob (ADR 027). An ended Quest asks nothing more.
   */
  needsYou: Count,
  /**
   * The artifacts its completed Tasks, its own included, made, of a kind you review (a pull request,
   * doc, page or code), that still wait for your review: each once, however many Tasks made it.
   */
  readyForReview: Count,
  /** The journal sequence of the `QuestSummaryChanged` that published it. */
  revision: Revision,
}) {}

/** A Quest's summary before it is published: everything but its revision. */
export type QuestSummaryFields = Omit<QuestSummary, "revision">;

/**
 * A registered artifact a Task made, by a result it returned or its Attempt's file changes: one for
 * each Task that made it.
 */
export interface DeliveredArtifact extends Pick<Artifact, "kind" | "review"> {
  readonly artifactId: RegisteredArtifactId;
  readonly taskId: TaskId;
}

/** What the fold reads of a Task tree: the Tasks' places and states, what waits on you there, and what they made. */
export interface SummaryTree {
  readonly tasks: ReadonlyArray<Pick<Task, "id" | "parentId" | "state">>;
  readonly questions: ReadonlyArray<Pick<Question, "taskId" | "recipientId" | "state">>;
  readonly approvals: ReadonlyArray<Pick<ApprovalRequest, "taskId" | "state">>;
  readonly delivered: ReadonlyArray<DeliveredArtifact>;
}

const NO_TONES: ToneCounts = { needs: 0, working: 0, waiting: 0, done: 0, problem: 0, idle: 0 };

/** A Quest's summary, folded from the Task tree it sits in. */
export const questSummaryOf = (
  quest: Pick<Quest, "id" | "taskId" | "leadId" | "parentQuestId" | "threadId" | "state">,
  tree: SummaryTree,
): QuestSummaryFields => {
  const own = tree.tasks.find((task) => task.id === quest.taskId);
  const under = own === undefined ? [] : descendantsOf(own, tree.tasks);
  const ids = new Set<TaskId>([quest.taskId, ...under.map((task) => task.id)]);
  const tones = { ...NO_TONES };
  for (const task of under) tones[workTone[task.state]] += 1;
  const running = isActiveQuest(quest.state);
  const questions = tree.questions.filter(
    (question) => ids.has(question.taskId) && question.recipientId === null && question.state === "open",
  ).length;
  const approvals = tree.approvals.filter(
    (approval) => approval.taskId !== null && ids.has(approval.taskId) && approval.state === "pending",
  ).length;
  const completed = new Set(
    [own, ...under].flatMap((task) => (task !== undefined && isCompletedTask(task.state) ? [task.id] : [])),
  );
  const ready = new Set(
    tree.delivered.flatMap((artifact) =>
      completed.has(artifact.taskId) && ArtifactReviews.awaitsReview(artifact) ? [artifact.artifactId] : [],
    ),
  );
  return {
    questId: quest.id,
    taskId: quest.taskId,
    leadId: quest.leadId,
    parentQuestId: quest.parentQuestId,
    threadId: quest.threadId,
    state: quest.state,
    tones,
    needsYou: running ? questions + approvals + tones.problem : 0,
    readyForReview: ready.size,
  };
};

/** Whether two summaries say the same, whatever their revisions: only a change is journaled. */
export const sameSummary = (a: QuestSummaryFields, b: QuestSummaryFields): boolean =>
  a.questId === b.questId &&
  a.taskId === b.taskId &&
  a.leadId === b.leadId &&
  a.parentQuestId === b.parentQuestId &&
  a.threadId === b.threadId &&
  a.state === b.state &&
  WorkTone.literals.every((tone) => a.tones[tone] === b.tones[tone]) &&
  a.needsYou === b.needsYou &&
  a.readyForReview === b.readyForReview;
