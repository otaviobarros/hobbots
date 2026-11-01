import {
  type AgentId,
  isTerminalTask,
  type Message,
  type MessageId,
  partyOf,
  type Quest,
  type Question,
  type Task,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";

/**
 * How the chat shows a request's work (ADR 018, screen 17): the card under the request, the strip
 * under the header, the drawer, and the few moments that reach the chat. Everything here comes from
 * the Task records, never from what a hob wrote (STD-UI-008).
 */

/** Where a row stands, in the order the card lists them: what needs you first, done last. */
export type RowStatus = "needs-you" | "failed" | "blocked" | "running" | "waiting" | "done";

const RANK: Record<RowStatus, number> = { "needs-you": 0, failed: 1, blocked: 2, running: 3, waiting: 4, done: 5 };

/** The card shows at most this many rows; the rest open in the drawer. */
const CARD_ROWS = 4;

export interface WorkRow {
  /** The Task the row opens: a member's Task, or the current step of a Task with steps. */
  readonly task: Task;
  readonly status: RowStatus;
  /** The hobs whose unfinished Tasks this one waits on. */
  readonly waitsOn: ReadonlyArray<AgentId>;
  /** For a row that stands for a Task's steps: which step is current, from 1. */
  readonly step: { readonly index: number; readonly total: number } | null;
  /** What the Task last reported, if anything. */
  readonly latest: string | null;
}

export interface WorkCard {
  readonly top: Task;
  readonly quest: Quest | null;
  /** The hob you asked: the Task's owner, the Quest's lead. */
  readonly leadId: AgentId;
  readonly party: ReadonlyArray<AgentId>;
  /** The rows the card shows, at most `CARD_ROWS`, in the order of `RowStatus`. */
  readonly rows: ReadonlyArray<WorkRow>;
  /** Unfinished rows past `CARD_ROWS`. */
  readonly more: number;
  /** Rows that are done, folded into a count. */
  readonly done: number;
  /** Done Tasks and all Tasks under the top one, for the progress line. */
  readonly progress: { readonly done: number; readonly total: number };
  readonly status: RowStatus;
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

/** Where a Task stands for you: a question waiting for you anywhere under it comes first. */
const rowStatus = (tree: TaskTree, task: Task): RowStatus => {
  const under = subtreeIds(tree, task.id);
  if (questionsForYou(tree).some((question) => under.has(question.taskId))) return "needs-you";
  switch (task.state) {
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "waiting":
      return "waiting";
    case "completed":
    case "cancelled":
      return "done";
    default:
      return "running";
  }
};

/** What the Task's owner last reported; automatic checkpoints only repeat its state. */
const latestOf = (tree: TaskTree, task: Task): string | null =>
  tree.checkpoints.findLast((checkpoint) => checkpoint.taskId === task.id && checkpoint.source !== "automatic")
    ?.summary ?? null;

const waitsOnOf = (tree: TaskTree, task: Task): ReadonlyArray<AgentId> => [
  ...new Set(
    task.dependsOn.flatMap((id) => {
      const dependency = tree.tasks.find((each) => each.id === id);
      return dependency === undefined || isTerminalTask(dependency.state) ? [] : [dependency.ownerId];
    }),
  ),
];

/** The step that runs now: the first that has not ended, or the last one once all have. */
const currentStep = (steps: ReadonlyArray<Task>) => {
  const index = steps.findIndex((step) => !isTerminalTask(step.state));
  return index === -1 ? steps.length - 1 : index;
};

/** One row per member's Task and one for the Task's own steps, showing only its current step. */
const workRows = (tree: TaskTree, top: Task): ReadonlyArray<WorkRow> => {
  const children = childrenOf(tree, top.id);
  const steps = children.filter((child) => child.ownerId === top.ownerId);
  const rows: Array<WorkRow> = children
    .filter((child) => child.ownerId !== top.ownerId)
    .map((task) => ({
      task,
      status: rowStatus(tree, task),
      waitsOn: waitsOnOf(tree, task),
      step: null,
      latest: latestOf(tree, task),
    }));
  const current = steps[currentStep(steps)];
  if (current !== undefined) {
    const allDone = steps.every((step) => isTerminalTask(step.state));
    rows.unshift({
      task: current,
      status: allDone ? "done" : rowStatus(tree, current),
      waitsOn: waitsOnOf(tree, current),
      step: { index: steps.indexOf(current) + 1, total: steps.length },
      latest: latestOf(tree, current),
    });
  }
  return rows
    .map((row, order) => ({ row, order }))
    .sort(byRank)
    .map(({ row }) => row);
};

const byRank = (a: { row: WorkRow; order: number }, b: { row: WorkRow; order: number }) =>
  RANK[a.row.status] - RANK[b.row.status] || a.order - b.order;

/** The card for a request's Task tree. */
export const workCard = (tree: TaskTree): WorkCard | null => {
  const top = tree.tasks[0];
  if (top === undefined) return null;
  const quest = tree.quests.find((each) => each.taskId === top.id) ?? null;
  const rows = workRows(tree, top);
  const open = rows.filter((row) => row.status !== "done");
  const under = tree.tasks.filter((task) => task.id !== top.id);
  return {
    top,
    quest,
    leadId: top.ownerId,
    party: quest === null ? [] : partyOf(quest, tree.delegations),
    rows: open.slice(0, CARD_ROWS),
    more: Math.max(0, open.length - CARD_ROWS),
    done: rows.length - open.length,
    progress: {
      done: under.filter((task) => task.state === "completed").length,
      total: under.length,
    },
    status: rowStatus(tree, top),
  };
};

/** How many of a tree's Tasks under the top one stand where, for the strip. */
export const workCounts = (tree: TaskTree): Readonly<Record<RowStatus, number>> => {
  const counts: Record<RowStatus, number> = { "needs-you": 0, failed: 0, blocked: 0, running: 0, waiting: 0, done: 0 };
  const top = tree.tasks[0];
  for (const task of tree.tasks) if (task !== top) counts[rowStatus(tree, task)] += 1;
  counts["needs-you"] = questionsForYou(tree).length;
  return counts;
};

/** The trees whose work has not ended: the strip keeps them in view. */
export const liveTrees = (trees: ReadonlyArray<TaskTree>): ReadonlyArray<TaskTree> =>
  trees.filter((tree) => tree.tasks[0] !== undefined && !isTerminalTask(tree.tasks[0].state));

/** Something about the work that the chat itself shows, under the message it follows. */
export type Moment =
  | { readonly kind: "card"; readonly tree: TaskTree; readonly at: string }
  /** A question that reached you, open or answered by you. */
  | { readonly kind: "question"; readonly tree: TaskTree; readonly question: Question; readonly at: string }
  /** A lead answered a member's question, so it never reached you. */
  | { readonly kind: "answered"; readonly tree: TaskTree; readonly question: Question; readonly at: string };

const momentsOf = (tree: TaskTree): ReadonlyArray<Moment> => {
  const top = tree.tasks[0];
  if (top === undefined) return [];
  const moments: Array<Moment> = [{ kind: "card", tree, at: top.createdAt }];
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
 * Places each moment after the message it follows in time. A card goes under the request that
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
      (message) => message.createdAt <= moment.at && (moment.kind !== "card" || message.role === "user"),
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

/** What the drawer shows for a Task: its brief, checkpoints, questions and output. */
export const taskDetail = (tree: TaskTree, task: Task) => {
  const delegation = tree.delegations.find((each) => each.childTaskId === task.id) ?? null;
  const received = new Set(tree.handOffs.filter((each) => each.toTaskId === task.id).map((each) => each.artifactId));
  return {
    brief: delegation?.brief ?? task.brief,
    expected: delegation?.expectedOutput ?? null,
    from: delegation?.leadId ?? null,
    status: rowStatus(tree, task),
    milestones: tree.milestones.filter((each) => each.taskId === task.id).sort((a, b) => a.position - b.position),
    checkpoints: tree.checkpoints.filter((each) => each.taskId === task.id),
    questions: tree.questions.filter((each) => each.taskId === task.id),
    output: tree.artifacts.filter((each) => each.taskId === task.id),
    given: tree.artifacts.filter((each) => received.has(each.id)),
    rows: workRowsAll(tree, task),
  };
};

/** Every Task right under one, done ones included, for Show all. */
const workRowsAll = (tree: TaskTree, task: Task): ReadonlyArray<WorkRow> =>
  childrenOf(tree, task.id).map((child) => ({
    task: child,
    status: rowStatus(tree, child),
    waitsOn: waitsOnOf(tree, child),
    step: null,
    latest: latestOf(tree, child),
  }));

/** The first line of a brief, as a Task's title. */
export const taskTitle = (task: Pick<Task, "brief">): string => task.brief.split("\n", 1)[0]?.trim() ?? "";
