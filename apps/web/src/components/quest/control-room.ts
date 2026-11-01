import { type AgentId, isTerminalTask, type Quest, type Task, type TaskId, type TaskTree } from "@hobbots/domain";
import { type RowStatus, rowStatus, waitsOnOf } from "./work-model.ts";

/**
 * The Quest tab's control room (ADR 018, CH-005): a request's whole Task tree with who owns each
 * Task, where it stands, how old it is and who it waits on, and the controls you may use on it.
 * Everything here comes from the Task records (STD-UI-008).
 */

/** Who a Task waits on: a hob, or you when a question climbed every lead. */
type Waited = { readonly kind: "hob"; readonly id: AgentId } | { readonly kind: "you" };

/** Where a Task stands in the tree: the card's statuses, with a cancel shown as it is. */
export type RoomStatus = RowStatus | "cancelling" | "cancelled";

export interface RoomRow {
  readonly task: Task;
  /** 0 for the Task you asked for, one more for each Task above. */
  readonly depth: number;
  readonly status: RoomStatus;
  /** The Quest this Task holds when its owner brought in hobs of its own: a nested Quest. */
  readonly quest: Quest | null;
  readonly waitingOn: ReadonlyArray<Waited>;
}

const roomStatus = (tree: TaskTree, task: Task): RoomStatus =>
  task.state === "cancelling" ? "cancelling" : task.state === "cancelled" ? "cancelled" : rowStatus(tree, task);

/**
 * Who the Task waits on: the owners of unfinished Tasks it depends on or its owner waits for, and
 * whoever holds a question it asked, in that order and once each.
 */
const waitingOnOf = (tree: TaskTree, task: Task): ReadonlyArray<Waited> => {
  if (isTerminalTask(task.state)) return [];
  const open = (id: TaskId) => {
    const each = tree.tasks.find((candidate) => candidate.id === id);
    return each !== undefined && !isTerminalTask(each.state) ? [each.ownerId] : [];
  };
  const waited = tree.waits.find((wait) => wait.taskId === task.id)?.on.flatMap(open) ?? [];
  const hobs = [...new Set([...waitsOnOf(tree, task), ...waited])].filter((id) => id !== task.ownerId);
  const asked = tree.questions.filter((question) => question.taskId === task.id && question.state === "open");
  const holders = [...new Set(asked.map((question) => question.recipientId))];
  return [
    ...[...new Set([...hobs, ...holders.filter((id): id is AgentId => id !== null)])].map(
      (id): Waited => ({ kind: "hob", id }),
    ),
    ...(holders.includes(null) ? [{ kind: "you" } as const] : []),
  ];
};

/** Every Task of the tree, each under its parent, in the order they were created. */
export const roomRows = (tree: TaskTree): ReadonlyArray<RoomRow> => {
  const children = new Map<TaskId | null, Array<Task>>();
  for (const task of tree.tasks) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  const top = tree.tasks[0];
  const rows: Array<RoomRow> = [];
  const visit = (task: Task, depth: number) => {
    if (rows.some((row) => row.task.id === task.id)) return;
    rows.push({
      task,
      depth,
      status: roomStatus(tree, task),
      quest: depth === 0 ? null : (tree.quests.find((quest) => quest.taskId === task.id) ?? null),
      waitingOn: waitingOnOf(tree, task),
    });
    for (const child of children.get(task.id) ?? []) visit(child, depth + 1);
  };
  if (top !== undefined) visit(top, 0);
  return rows;
};

export interface TaskControls {
  /** A failed Task can run again as a new Attempt (EX-001). */
  readonly retry: boolean;
  /** A member's unfinished Task can go to another hob, keeping its history. */
  readonly reassign: boolean;
  /** A Task under the top one that has not ended can be cancelled with everything under it. */
  readonly cancel: boolean;
}

/** The controls that apply to a Task where it stands. The top Task is cancelled with its Quest. */
export const taskControls = (tree: TaskTree, task: Task): TaskControls => {
  const open = !isTerminalTask(task.state) && task.state !== "cancelling";
  const top = task.id === tree.tasks[0]?.id;
  const delegated = tree.delegations.some((delegation) => delegation.childTaskId === task.id);
  return {
    retry: task.state === "failed",
    reassign: !top && delegated && (open || task.state === "failed"),
    cancel: !top && open,
  };
};

/** Cancelling the whole request: its Quest, or its Task while no party joined. */
export type TopCancel = "open" | "cancelling" | "ended";

export const topCancel = (tree: TaskTree): TopCancel => {
  const top = tree.tasks[0];
  if (top === undefined || isTerminalTask(top.state)) return "ended";
  return top.state === "cancelling" ? "cancelling" : "open";
};

/** How many Attempts the Task has had: 0 before it first starts, then one more for each retry. */
export const attemptCount = (tree: TaskTree, task: Task): number =>
  tree.attempts.reduce((most, attempt) => (attempt.taskId === task.id ? Math.max(most, attempt.number) : most), 0);
