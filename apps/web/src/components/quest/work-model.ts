import {
  type AgentId,
  type ApprovalRequest,
  checkpointOn,
  handedFrom,
  isTerminalTask,
  type Message,
  type MessageId,
  pendingApprovals,
  pendingApprovalsOn,
  type Quest,
  type Question,
  saysMore,
  type Task,
  type TaskId,
  TaskReadiness,
  type TaskTree,
} from "@hobbots/domain";
import { firstLine } from "../../lib/format.ts";
import { memberFolders } from "./member-folders.ts";

/**
 * How the chat shows a request's work (ADR 018, ADR 027, screen 17): the ticket under the request,
 * the quest buttons in the header, and the few moments that reach the chat. Everything here comes from
 * the Task records, never from what a hob wrote (STD-UI-008).
 */

/** Where a Task stands for you, from what needs you to what is done. */
export type RowStatus = "needs-you" | "failed" | "blocked" | "running" | "waiting" | "done";

/** A Task right under another, as Task details list them. */
export interface WorkRow {
  readonly task: Task;
  readonly status: RowStatus;
  /** The hobs whose unfinished Tasks this one waits on. */
  readonly waitsOn: ReadonlyArray<AgentId>;
  /** What the Task last reported, if anything. */
  readonly latest: string | null;
  /** The first action its turn waits on you to approve, which the row names (#698). */
  readonly approval: ApprovalRequest | null;
}

export interface WorkCard {
  readonly top: Task;
  readonly quest: Quest | null;
  /** The hob you asked: the Task's owner, the Quest's lead. */
  readonly leadId: AgentId;
  /** Done Tasks and all Tasks under the top one, for the progress line. */
  readonly progress: { readonly done: number; readonly total: number };
}

const childrenOf = (tree: TaskTree, id: TaskId) => tree.tasks.filter((task) => task.parentId === id);

const subtreeIds = (tree: TaskTree, id: TaskId): ReadonlySet<TaskId> => {
  const ids = new Set<TaskId>([id]);
  for (const task of tree.tasks) if (task.parentId !== null && ids.has(task.parentId)) ids.add(task.id);
  return ids;
};

/** Questions that climbed every lead and wait for you. */
const questionsForYou = (tree: TaskTree): ReadonlyArray<Question> =>
  tree.questions.filter((question) => question.recipientId === null && question.state === "open");

/**
 * Where a Task stands for you: a question or an approval waiting for you anywhere under it comes
 * first, since its turn cannot go on until you act (#698).
 */
export const rowStatus = (tree: TaskTree, task: Task): RowStatus => {
  const under = subtreeIds(tree, task.id);
  const asks = [...questionsForYou(tree), ...pendingApprovals(tree)];
  if (asks.some((ask) => under.has(ask.taskId))) return "needs-you";
  switch (task.state) {
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "waiting":
      return "waiting";
    // A Task that comes after others starts only once they have completed (ADR 018): until then it
    // waits on them, or is blocked when one of them needs someone to act first.
    case "queued": {
      const readiness = TaskReadiness.of(task, tree.tasks)._tag;
      return readiness === "Ready" ? "running" : readiness === "Blocked" ? "blocked" : "waiting";
    }
    case "completed":
    case "cancelled":
      return "done";
    default:
      return "running";
  }
};

/**
 * What the Task's owner last reported, or a finding the hub made about it, such as another Task
 * changing a file it changed; the other automatic checkpoints only repeat its state.
 */
const latestOf = (tree: TaskTree, task: Task): string | null =>
  tree.checkpoints.findLast((checkpoint) => checkpointOn(checkpoint, task.id) && saysMore(checkpoint))?.summary ?? null;

/** The hobs whose Tasks this one comes after and that have not completed, failed ones included. */
export const waitsOnOf = (tree: TaskTree, task: Task): ReadonlyArray<AgentId> => [
  ...new Set(
    TaskReadiness.unmet(TaskReadiness.of(task, tree.tasks)).flatMap((id) =>
      tree.tasks.filter((each) => each.id === id).map((each) => each.ownerId),
    ),
  ),
];

/** What the ticket, the quest button and the room header say of a request's work: who leads it and how far it is. */
export const workCard = (tree: TaskTree): WorkCard | null => {
  const top = tree.tasks[0];
  if (top === undefined) return null;
  const quest = tree.quests.find((each) => each.taskId === top.id) ?? null;
  const under = tree.tasks.filter((task) => task.id !== top.id);
  return {
    top,
    quest,
    leadId: top.ownerId,
    progress: {
      done: under.filter((task) => task.state === "completed").length,
      total: under.length,
    },
  };
};

/** How many of a tree's Tasks under the top one stand where, for the strip. */
export const workCounts = (tree: TaskTree): Readonly<Record<RowStatus, number>> => {
  const counts: Record<RowStatus, number> = { "needs-you": 0, failed: 0, blocked: 0, running: 0, waiting: 0, done: 0 };
  const top = tree.tasks[0];
  for (const task of tree.tasks) if (task !== top) counts[rowStatus(tree, task)] += 1;
  counts["needs-you"] = questionsForYou(tree).length + pendingApprovals(tree).length;
  return counts;
};

/** The trees whose work has not ended: the strip keeps them in view. */
export const liveTrees = (trees: ReadonlyArray<TaskTree>): ReadonlyArray<TaskTree> =>
  trees.filter((tree) => tree.tasks[0] !== undefined && !isTerminalTask(tree.tasks[0].state));

/** Something about the work that the chat itself shows, under the message it follows. */
export type Moment =
  | { readonly kind: "ticket"; readonly tree: TaskTree; readonly at: string }
  /** A question that reached you, open or answered by you. */
  | { readonly kind: "question"; readonly tree: TaskTree; readonly question: Question; readonly at: string }
  /** A lead answered a member's question, so it never reached you. */
  | { readonly kind: "answered"; readonly tree: TaskTree; readonly question: Question; readonly at: string };

const momentsOf = (tree: TaskTree): ReadonlyArray<Moment> => {
  const top = tree.tasks[0];
  if (top === undefined) return [];
  const moments: Array<Moment> = [{ kind: "ticket", tree, at: top.createdAt }];
  for (const question of tree.questions) {
    if (question.answeredBy?._tag === "Lead" && question.answeredAt !== null) {
      moments.push({ kind: "answered", tree, question, at: question.answeredAt });
    } else if (question.recipientId === null) {
      moments.push({ kind: "question", tree, question, at: question.createdAt });
    }
  }
  return moments;
};

/** Where moments before the first message go. */
export const BEFORE_ALL = "before-all";

/**
 * Places each moment after the message it follows in time. A ticket goes under the request that
 * started its Task: the last message of yours before it, not the reply that was already running.
 */
export const placeMoments = (
  transcript: ReadonlyArray<Message>,
  trees: ReadonlyArray<TaskTree>,
): ReadonlyMap<MessageId | typeof BEFORE_ALL, ReadonlyArray<Moment>> => {
  const placed = new Map<MessageId | typeof BEFORE_ALL, Array<Moment>>();
  const moments = trees.flatMap(momentsOf).sort((a, b) => a.at.localeCompare(b.at));
  for (const moment of moments) {
    const anchor = transcript.findLast(
      (message) => message.createdAt <= moment.at && (moment.kind !== "ticket" || message.role === "user"),
    );
    const key = anchor?.id ?? BEFORE_ALL;
    placed.set(key, [...(placed.get(key) ?? []), moment]);
  }
  return placed;
};

/** A Task and where it sits: its tree, and the Task above it when there is one. */
export const findTask = (trees: ReadonlyArray<TaskTree>, taskId: TaskId) => {
  for (const tree of trees) {
    const task = tree.tasks.find((each) => each.id === taskId);
    if (task !== undefined) {
      const parent = task.parentId === null ? null : (tree.tasks.find((each) => each.id === task.parentId) ?? null);
      return { tree, task, parent };
    }
  }
  return null;
};

/**
 * The completed Tasks the Task's work builds on, once each: those it comes after, whose results and
 * artifacts the hub gives it when it starts (ADR 018), then those whose artifacts were handed to it,
 * whose results its later turns are told (#567).
 */
const returnedTo = (tree: TaskTree, task: Task): ReadonlyArray<Task> =>
  [...new Set([...task.dependsOn, ...handedFrom(tree, task.id)])].flatMap((id) =>
    tree.tasks.filter((each) => each.id === id && each.id !== task.id && each.result !== null),
  );

/** What the drawer shows for a Task: its brief, checkpoints, questions and output, and what it was given. */
export const taskDetail = (tree: TaskTree, task: Task) => {
  const delegation = tree.delegations.find((each) => each.childTaskId === task.id) ?? null;
  const returned = returnedTo(tree, task);
  const received = new Set([
    ...tree.handOffs.filter((each) => each.toTaskId === task.id).map((each) => each.artifactId),
    // Every artifact of a Task it comes after reaches it; of another Task, only what was handed on.
    ...tree.artifacts
      .filter((each) => task.dependsOn.includes(each.taskId) && returned.some((done) => done.id === each.taskId))
      .map((each) => each.id),
  ]);
  return {
    brief: delegation?.brief ?? task.brief,
    expected: delegation?.expectedOutput ?? null,
    from: delegation?.leadId ?? null,
    folders: memberFolders(tree, task),
    status: rowStatus(tree, task),
    milestones: tree.milestones.filter((each) => each.taskId === task.id).sort((a, b) => a.position - b.position),
    checkpoints: tree.checkpoints.filter((each) => checkpointOn(each, task.id)),
    questions: tree.questions.filter((each) => each.taskId === task.id),
    approvals: tree.approvals.filter((each) => each.taskId === task.id),
    // Your notes only: a lead's message to its member's Task is the hobs' own (#574).
    notes: tree.notes.filter((each) => each.taskId === task.id && (each.senderId ?? null) === null),
    output: tree.artifacts.filter((each) => each.taskId === task.id),
    given: tree.artifacts.filter((each) => received.has(each.id)),
    returned,
    rows: workRowsAll(tree, task),
  };
};

/** The first question on a Task that waits for you. */
export const questionForYou = (tree: TaskTree, task: Task): Question | null =>
  questionsForYou(tree).find((question) => question.taskId === task.id) ?? null;

/** Every Task right under one, done ones included, for Show all. */
const workRowsAll = (tree: TaskTree, task: Task): ReadonlyArray<WorkRow> =>
  childrenOf(tree, task.id).map((child) => ({
    task: child,
    status: rowStatus(tree, child),
    waitsOn: waitsOnOf(tree, child),
    latest: latestOf(tree, child),
    approval: pendingApprovalsOn(tree, child.id)[0] ?? null,
  }));

/** The first line of a brief, as a Task's title. */
export const taskTitle = (task: Pick<Task, "brief">): string => firstLine(task.brief);
