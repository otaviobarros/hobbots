import {
  type AgentId,
  ancestorsOf,
  checkpointOn,
  descendantsOf,
  isTerminalTask,
  partyOf,
  pendingApprovals,
  type Quest,
  type Task,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { ApiError } from "../../api/client.ts";
import { messages } from "./messages.ts";
import { type RowStatus, rowStatus, waitsOnOf } from "./work-model.ts";

/**
 * The Quest tab's control room (ADR 018, CH-005): a request's whole Task tree with who owns each
 * Task, where it stands, how old it is and who it waits on, and the controls you may use on it.
 * Everything here comes from the Task records (STD-UI-008).
 */

/** Who a Task waits on: a hob, or you when a question climbed every lead or an action waits on your approval. */
type Waited = { readonly kind: "hob"; readonly id: AgentId } | { readonly kind: "you" };

/**
 * Where a Task stands in the tree: the card's statuses, with a cancel shown as it is: asked for
 * (`cancelling`), confirmed (`cancelled`), or ended without the hub confirming its session stopped
 * (`unresolved`, OR-006).
 */
export type RoomStatus = RowStatus | "cancelling" | "cancelled" | "unresolved";

export interface RoomRow {
  readonly task: Task;
  /** 0 for the Task you asked for, one more for each Task above. */
  readonly depth: number;
  readonly status: RoomStatus;
  /** The Quest this Task holds when its owner brought in hobs of its own: a nested Quest. */
  readonly quest: Quest | null;
  /** The hobs the owner brought in on that nested Quest, the sub-lead's own party. */
  readonly party: ReadonlyArray<AgentId>;
  readonly waitingOn: ReadonlyArray<Waited>;
  /** The hobs whose Tasks changed a file this Task changed too, as the hub found it (#570). */
  readonly sameFileAs: ReadonlyArray<AgentId>;
}

/** Whether a cancelled Task's stop was never confirmed: its last Attempt was left unresolved. */
const isUnresolved = (tree: TaskTree, task: Task): boolean =>
  task.state === "cancelled" &&
  tree.attempts.some((attempt) => attempt.id === task.currentAttemptId && attempt.state === "unresolved");

export const roomStatus = (tree: TaskTree, task: Task): RoomStatus => {
  if (task.state === "cancelling") return "cancelling";
  if (task.state === "cancelled") return isUnresolved(tree, task) ? "unresolved" : "cancelled";
  return rowStatus(tree, task);
};

/**
 * A cancel shows in the waiting tone: nothing runs, and nothing is done either. One whose stop was
 * never confirmed shows in the tone of work that needs a look.
 */
export const roomTone = (status: RoomStatus): RowStatus =>
  status === "unresolved" ? "blocked" : status === "cancelling" || status === "cancelled" ? "waiting" : status;

export const roomStatusLabel = (status: RoomStatus): string =>
  status === "cancelling" || status === "cancelled" || status === "unresolved"
    ? messages.room.status[status]
    : messages.status[status];

/**
 * Who the Task waits on: the owners of unfinished Tasks it depends on or its owner waits for, and
 * whoever holds a question it asked, in that order and once each, then you for a question or an
 * approval its turn waits on.
 */
const waitingOnOf = (tree: TaskTree, task: Task): ReadonlyArray<Waited> => {
  if (isTerminalTask(task.state)) return [];
  const open = (id: TaskId) => {
    const each = tree.tasks.find((candidate) => candidate.id === id);
    return each !== undefined && !isTerminalTask(each.state) ? [each.ownerId] : [];
  };
  // A wait counts only while the Task waits; the hub keeps the last one after it moves on.
  const waited =
    task.state === "waiting" ? (tree.waits.find((wait) => wait.taskId === task.id)?.on.flatMap(open) ?? []) : [];
  const hobs = [...new Set([...waitsOnOf(tree, task), ...waited])].filter((id) => id !== task.ownerId);
  const asked = tree.questions.filter((question) => question.taskId === task.id && question.state === "open");
  const holders = [...new Set(asked.map((question) => question.recipientId))];
  return [
    ...[...new Set([...hobs, ...holders.filter((id): id is AgentId => id !== null)])].map(
      (id): Waited => ({ kind: "hob", id }),
    ),
    ...(holders.includes(null) || pendingApprovals(tree).some((approval) => approval.taskId === task.id)
      ? [{ kind: "you" } as const]
      : []),
  ];
};

/**
 * The owners of the other Tasks a hub finding pairs with this one: two Tasks of the work changed
 * the same file. The finding sits on the Task that changed it last and names the other.
 */
const sameFileAsOf = (tree: TaskTree, task: Task): ReadonlyArray<AgentId> => [
  ...new Set(
    tree.checkpoints.flatMap((checkpoint) => {
      if (checkpoint.source !== "automatic" || checkpoint.kind !== "finding" || !checkpointOn(checkpoint, task.id))
        return [];
      const otherId = checkpoint.taskId === task.id ? checkpoint.aboutTaskId : checkpoint.taskId;
      const other = tree.tasks.find((each) => each.id === otherId);
      return other === undefined ? [] : [other.ownerId];
    }),
  ),
];

/** Every Task of the tree, each under its parent, in the order they were created. */
export const roomRows = (tree: TaskTree): ReadonlyArray<RoomRow> => {
  const children = new Map<TaskId | null, Array<Task>>();
  for (const task of tree.tasks) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  const top = tree.tasks[0];
  const rows: Array<RoomRow> = [];
  const visit = (task: Task, depth: number) => {
    if (rows.some((row) => row.task.id === task.id)) return;
    const quest = depth === 0 ? null : (tree.quests.find((each) => each.taskId === task.id) ?? null);
    rows.push({
      task,
      depth,
      status: roomStatus(tree, task),
      quest,
      party: quest === null ? [] : partyOf(quest, tree.delegations),
      waitingOn: waitingOnOf(tree, task),
      sameFileAs: sameFileAsOf(tree, task),
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

/**
 * The controls that apply to a Task where it stands. The top Task is cancelled with its Quest and
 * retried by asking its hob again. A Task changes hands only when it is a member's, leads no Quest
 * of its own and has nothing open under it.
 */
export const taskControls = (tree: TaskTree, task: Task): TaskControls => {
  const open = !isTerminalTask(task.state) && task.state !== "cancelling";
  const top = task.id === tree.tasks[0]?.id;
  const delegated = tree.delegations.some((delegation) => delegation.childTaskId === task.id);
  const leads = tree.quests.some((quest) => quest.taskId === task.id);
  const busyUnder = descendantsOf(task, tree.tasks).some((each) => !isTerminalTask(each.state));
  return {
    retry: !top && task.state === "failed",
    reassign: !top && delegated && !leads && !busyUnder && (open || task.state === "failed"),
    cancel: !top && open,
  };
};

/**
 * The hobs a Task can go to: any hob you have that is not its owner and owns nothing on its way up,
 * since the hub refuses those (ADR 018). `hobs` are the hub's active hobs, in the order it lists them.
 */
export const reassignTargets = <H extends { readonly id: AgentId }>(
  tree: TaskTree,
  task: Task,
  hobs: ReadonlyArray<H>,
): ReadonlyArray<H> => {
  const above = new Set(ancestorsOf(task, tree.tasks).map((each) => each.ownerId));
  return hobs.filter((hob) => hob.id !== task.ownerId && !above.has(hob.id));
};

/**
 * What a cancel did to a Task and everything under it, from the records: how many Tasks it asked to
 * stop, how many confirmed they stopped, and how many ended without that confirmation. Null while
 * nothing there was cancelled.
 */
export interface CancelOutcome {
  readonly total: number;
  readonly confirmed: number;
  readonly unresolved: number;
  /** Every Task asked has ended, confirmed or not. */
  readonly settled: boolean;
}

export const cancelOutcome = (tree: TaskTree, task: Task): CancelOutcome | null => {
  const latest = tree.tasks.find((each) => each.id === task.id) ?? task;
  if (latest.state !== "cancelling" && latest.state !== "cancelled") return null;
  const cancelled = [latest, ...descendantsOf(latest, tree.tasks)].filter(
    (each) => each.state === "cancelling" || each.state === "cancelled",
  );
  const unresolved = cancelled.filter((each) => isUnresolved(tree, each)).length;
  const ended = cancelled.filter((each) => each.state === "cancelled").length;
  return {
    total: cancelled.length,
    confirmed: ended - unresolved,
    unresolved,
    settled: ended === cancelled.length,
  };
};

/**
 * A Task you retried or gave to another hob waits in the queue until its owner starts the new
 * Attempt: the hub recorded the change, and the start is what shows it took. Null otherwise.
 */
export const pendingStart = (tree: TaskTree, task: Task): { readonly attempt: number } | null => {
  const attempts = attemptCount(tree, task);
  return task.state === "queued" && attempts > 0 ? { attempt: attempts + 1 } : null;
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

const refused = messages.room.refused;

type Names = { readonly owner: string; readonly target: string };

/** The tab's words for each reason the hub gives for refusing a control. */
const REFUSALS: Readonly<Record<string, (names: Names) => string>> = {
  "attempt-live": ({ owner }) => refused["attempt-live"]({ name: owner }),
  "same-owner": ({ target }) => refused["same-owner"]({ name: target }),
  "lineage-owner": ({ target }) => refused["lineage-owner"]({ name: target }),
  "task-ended": () => refused["task-ended"],
  "task-state": () => refused["task-state"],
  "task-cancelling": () => refused["task-cancelling"],
  "parent-cancelling": () => refused["parent-cancelling"],
  "children-open": () => refused["children-open"],
  "quest-exists": () => refused["quest-exists"],
};

/**
 * Why a control was refused or failed, in the tab's words: the hub's reason when it gave one it
 * knows, `owner` being the Task's hob and `target` the hob a Reassign picked.
 */
export const controlError = (error: unknown, names: Names): string => {
  if (!(error instanceof ApiError) || error.tag === undefined) return refused.failed;
  if (error.tag === "HobUnavailable") return refused.retired({ name: names.target });
  if (error.tag === "AgentNotFound") return refused.gone;
  if (error.tag !== "TaskNotControllable") return refused.other({ message: error.message });
  const known = REFUSALS[String(error.fields.reason ?? "")];
  return known?.(names) ?? refused.other({ message: String(error.fields.message ?? error.message) });
};
