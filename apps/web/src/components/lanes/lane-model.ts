import {
  type AgentId,
  type Attempt,
  type AttemptActivity,
  type AttemptId,
  type CommandRecord,
  type FileChange,
  isTerminalTask,
  liveAttemptOn,
  pendingApprovalsOn,
  saysMore,
  type Task,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { type RoomStatus, roomRows, roomStatus } from "../quest/control-room.ts";
import { questionForYou, taskTitle } from "../quest/work-model.ts";

/**
 * The Quest room's lanes (ADR 027): one per hob on the Quest, built from the Task tree and the
 * Workbench records of its Attempts. Nothing here calls a model or reads what a hob wrote about its
 * own state, so a lane cannot show a step that did not happen (STD-UI-008).
 */

/** What a lane says the hob is to its party: the Quest's lead, a member that leads its own party, or a member. */
export type LaneRole =
  | { readonly kind: "lead" }
  | { readonly kind: "leads"; readonly members: ReadonlyArray<AgentId> }
  | { readonly kind: "member" };

/** Who a Task waits on: a hob, or you. */
export type LaneWaited = { readonly kind: "hob"; readonly id: AgentId } | { readonly kind: "you" };

/** A compact mark for something the hob did, from its tool steps, commands and file changes. */
export type LaneMark =
  | { readonly kind: "read"; readonly key: string; readonly path: string }
  | {
      readonly kind: "edit";
      readonly key: string;
      readonly path: string;
      /** The change and its Attempt's records, so the lane can count the lines it added. */
      readonly change: FileChange;
      readonly activity: AttemptActivity;
    }
  | { readonly kind: "delete"; readonly key: string; readonly path: string }
  | { readonly kind: "run"; readonly key: string; readonly command: CommandRecord };

/** What a lane shows, in its order. */
export type LaneItem =
  | LaneMark
  /** A milestone, finding or report the hob made, or a finding the hub made about its Task. */
  | { readonly kind: "beat"; readonly key: string; readonly text: string }
  /** A tool call that was refused, with what the hob was told. */
  | { readonly kind: "refused"; readonly key: string; readonly what: string; readonly reason: string }
  /** Older marks, folded into a count so a long lane stays readable. */
  | { readonly kind: "folded"; readonly key: string; readonly marks: ReadonlyArray<LaneMark> }
  | { readonly kind: "hand-out"; readonly key: string; readonly label: string; readonly to: AgentId }
  | { readonly kind: "hand-in"; readonly key: string; readonly label: string; readonly from: AgentId }
  | { readonly kind: "briefed"; readonly key: string; readonly members: ReadonlyArray<AgentId> }
  /** Where a hob with more than one Task on the Quest starts the next. */
  | { readonly kind: "task"; readonly key: string; readonly title: string }
  | { readonly kind: "wait"; readonly key: string; readonly on: ReadonlyArray<LaneWaited> }
  /** A turn runs now: the step it is on, or null before it reported one. */
  | { readonly kind: "now"; readonly key: string; readonly label: string | null }
  | {
      readonly kind: "result";
      readonly key: string;
      readonly outcome: "completed" | "failed" | "cancelled";
      /** The Task's result, or why the hub stopped it; null when neither was recorded. */
      readonly text: string | null;
    };

export interface Lane {
  readonly hobId: AgentId;
  readonly role: LaneRole;
  /** The Task the header names: the first of the hob's Tasks that has not ended, else its last. */
  readonly task: Task;
  readonly title: string;
  readonly status: RoomStatus;
  readonly items: ReadonlyArray<LaneItem>;
}

/** A lane, with the lanes of the party its hob leads when it leads a Quest of its own. */
export interface LaneNode {
  readonly lane: Lane;
  readonly party: ReadonlyArray<LaneNode>;
}

export interface LaneRoom {
  /** The lead's lane, then a node for each member of its party. */
  readonly lanes: ReadonlyArray<LaneNode>;
  /** Every lane in the order it shows, for the header's lineup. */
  readonly order: ReadonlyArray<Lane>;
}

/** How many marks a lane shows before the older ones fold into a count. */
export const SHOWN_MARKS = 6;

/** A Task's own records and those of the steps under it, which stay in its owner's lane. */
const unitOf = (tree: TaskTree, task: Task): ReadonlyArray<Task> => {
  const unit = [task];
  for (const each of tree.tasks) {
    if (each.ownerId === task.ownerId && unit.some((member) => member.id === each.parentId)) unit.push(each);
  }
  return unit;
};

/** Whether a Task is a step: a part of its owner's own work, which never gets a lane of its own. */
const isStep = (tree: TaskTree, task: Task): boolean =>
  task.parentId !== null && tree.tasks.some((each) => each.id === task.parentId && each.ownerId === task.ownerId);

/** The hob that brought this Task's owner in: the owner of the nearest Task above it that is not its own. */
const leadOf = (tree: TaskTree, task: Task): AgentId | null => {
  let parentId = task.parentId;
  while (parentId !== null) {
    const parent = tree.tasks.find((each) => each.id === parentId);
    if (parent === undefined) return null;
    if (parent.ownerId !== task.ownerId) return parent.ownerId;
    parentId = parent.parentId;
  }
  return null;
};

/** The Attempt a Task's lane shows: its latest. */
const shownAttempt = (tree: TaskTree, task: Task): Attempt | undefined =>
  tree.attempts
    .filter((each) => each.taskId === task.id)
    .reduce<Attempt | undefined>(
      (latest, each) => (latest === undefined || each.number > latest.number ? each : latest),
      undefined,
    );

/** A lane item with the time it happened, to put a lane in order. */
type Timed = { readonly at: string; readonly item: LaneItem };

/** A path shown from inside the hob's folder it is in, so a lane reads `docs/copy.md`, not the whole path. */
export const shortPath = (path: string, folders: ReadonlyArray<string>): string => {
  const folder = folders
    .filter((each) => path.startsWith(each.endsWith("/") ? each : `${each}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (folder === undefined) return path;
  return path.slice(folder.length).replace(/^\/+/, "");
};

const foldersOf = (activity: AttemptActivity): ReadonlyArray<string> => [
  ...new Set([
    ...activity.scans.map((each) => each.folder),
    ...activity.changes.map((each) => each.folder),
    ...activity.commands.map((each) => each.folder),
  ]),
];

const changeMark = (change: FileChange, activity: AttemptActivity): LaneMark =>
  change.kind === "deleted"
    ? { kind: "delete", key: `change-${change.id}`, path: change.path }
    : { kind: "edit", key: `change-${change.id}`, path: change.path, change, activity };

/** What an Attempt's records add to its lane: reads and refused calls from its steps, its commands and changes. */
const activityItems = (activity: AttemptActivity): ReadonlyArray<Timed> => {
  const folders = foldersOf(activity);
  const fallback = activity.attempt.startedAt;
  const steps = activity.steps.flatMap((step): ReadonlyArray<Timed> => {
    const at = step.startedAt ?? fallback;
    if (step.state === "denied") {
      const item = { kind: "refused", key: `step-${step.id}`, what: step.label, reason: step.reason ?? "" } as const;
      return [{ at, item }];
    }
    if (step.call?.operation !== "read-files") return [];
    return step.call.targets.map((target, index) => ({
      at,
      item: { kind: "read", key: `step-${step.id}-${index}`, path: shortPath(target, folders) },
    }));
  });
  const commands = activity.commands.map((command) => ({
    at: command.startedAt,
    item: { kind: "run", key: `command-${command.id}`, command } as const,
  }));
  const changes = activity.changes
    .filter((change) => change.kind !== "link")
    .map((change) => ({ at: change.recordedAt, item: changeMark(change, activity) }));
  return [...steps, ...commands, ...changes];
};

/** What the hob reported on a Task and the hub found about it, shown in the Attempt the lane shows. */
const beatItems = (tree: TaskTree, task: Task, attemptId: AttemptId | undefined): ReadonlyArray<Timed> =>
  tree.checkpoints
    .filter(
      (each) => each.taskId === task.id && saysMore(each) && (each.attemptId === null || each.attemptId === attemptId),
    )
    .map((each) => ({ at: each.createdAt, item: { kind: "beat", key: `checkpoint-${each.id}`, text: each.summary } }));

/** The Task tool calls the hub refused for the Task, with what it told the hob. */
const refusalItems = (tree: TaskTree, task: Task): ReadonlyArray<Timed> =>
  tree.refusals
    .filter((each) => each.taskId === task.id)
    .map((each) => ({
      at: each.refusedAt,
      item: { kind: "refused", key: `refusal-${each.id}`, what: each.tool, reason: each.message },
    }));

/** Work handed from one hob's Task to another's: out in the giver's lane, in in the taker's. */
const handOffItems = (tree: TaskTree, unit: ReadonlyArray<Task>): ReadonlyArray<Timed> => {
  const ids = new Set(unit.map((each) => each.id));
  const ownerOf = (id: TaskId) => tree.tasks.find((each) => each.id === id)?.ownerId;
  return tree.handOffs.flatMap((handOff, index): ReadonlyArray<Timed> => {
    const artifact = tree.artifacts.find((each) => each.id === handOff.artifactId);
    if (artifact === undefined) return [];
    const from = ownerOf(artifact.taskId);
    const to = ownerOf(handOff.toTaskId);
    if (from === undefined || to === undefined || from === to) return [];
    const key = `hand-${index}`;
    const at = handOff.createdAt;
    if (ids.has(artifact.taskId))
      return [{ at, item: { kind: "hand-out", key: `${key}-out`, label: artifact.label, to } }];
    if (ids.has(handOff.toTaskId))
      return [{ at, item: { kind: "hand-in", key: `${key}-in`, label: artifact.label, from } }];
    return [];
  });
};

/** The hobs a Task's owner briefed from it, once each, when it first briefed one. */
const briefedItems = (tree: TaskTree, unit: ReadonlyArray<Task>): ReadonlyArray<Timed> =>
  unit.flatMap((task) => {
    const briefs = tree.delegations
      .filter((each) => each.parentTaskId === task.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = briefs[0];
    if (first === undefined) return [];
    const members = [...new Set(briefs.map((each) => each.memberId))];
    return [{ at: first.createdAt, item: { kind: "briefed", key: `briefed-${task.id}`, members } }];
  });

/**
 * Folds every mark but the last `shown` into one count, where the first of them was. Beats, chips
 * and refused calls stay in place.
 */
export const foldMarks = (items: ReadonlyArray<LaneItem>, shown: number = SHOWN_MARKS): ReadonlyArray<LaneItem> => {
  const isMark = (item: LaneItem): item is LaneMark =>
    item.kind === "read" || item.kind === "edit" || item.kind === "delete" || item.kind === "run";
  const marks = items.filter(isMark);
  const hidden = new Set(marks.slice(0, Math.max(0, marks.length - shown)));
  if (hidden.size === 0) return items;
  const folded: LaneItem = { kind: "folded", key: `folded-${items[0]?.key ?? ""}`, marks: [...hidden] };
  const first = items.findIndex((item) => isMark(item) && hidden.has(item));
  return items.flatMap((item, index) => (index === first ? [folded] : isMark(item) && hidden.has(item) ? [] : [item]));
};

/** How a Task that ended ends its part of the lane: its result, or why the hub stopped it. */
const resultItem = (tree: TaskTree, task: Task): LaneItem | null => {
  const key = `result-${task.id}`;
  if (task.state === "completed")
    return { kind: "result", key, outcome: "completed", text: task.result?.summary ?? null };
  if (task.state === "cancelled") return { kind: "result", key, outcome: "cancelled", text: null };
  if (task.state !== "failed") return null;
  const reason = tree.checkpoints.findLast(
    (each) => each.taskId === task.id && (each.kind === "failed" || each.kind === "blocker"),
  );
  return { kind: "result", key, outcome: "failed", text: reason?.summary ?? null };
};

/** One of the hob's Tasks, with its steps: everything recorded on them in time order, then how it ended. */
const sectionOf = (tree: TaskTree, task: Task, readOf: (id: AttemptId) => AttemptActivity | undefined) => {
  const unit = unitOf(tree, task);
  const timed = unit.flatMap((each) => {
    const attempt = shownAttempt(tree, each);
    const activity = attempt === undefined ? undefined : readOf(attempt.id);
    return [
      ...beatItems(tree, each, attempt?.id),
      ...refusalItems(tree, each),
      ...(activity === undefined ? [] : activityItems(activity)),
    ];
  });
  const ordered = [...timed, ...handOffItems(tree, unit), ...briefedItems(tree, unit)]
    .map((each, order) => ({ ...each, order }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order)
    .map((each) => each.item);
  const result = resultItem(tree, task);
  return { unit, items: result === null ? ordered : [...ordered, result] };
};

/** The step a running turn is on, from the records of the Attempt that runs. */
const nowItem = (
  tree: TaskTree,
  unit: ReadonlyArray<Task>,
  readOf: (id: AttemptId) => AttemptActivity | undefined,
): LaneItem | null => {
  const running = unit.find((each) => liveAttemptOn(each, tree));
  if (running === undefined) return null;
  const activity = running.currentAttemptId === null ? undefined : readOf(running.currentAttemptId);
  const step = activity?.steps.findLast((each) => each.state === "running");
  return { kind: "now", key: `now-${running.id}`, label: step?.label ?? null };
};

/**
 * Where the lane's Task stands. A question or an approval waiting for you lights the lane of the hob
 * whose Task it is on; a lead with one under it shows where its own Task stands.
 */
const laneStatus = (tree: TaskTree, unit: ReadonlyArray<Task>, task: Task): RoomStatus => {
  const asks = unit.some((each) => questionForYou(tree, each) !== null || pendingApprovalsOn(tree, each.id).length > 0);
  if (asks) return "needs-you";
  const status = roomStatus(tree, task);
  if (status !== "needs-you") return status;
  return task.state === "waiting" ? "waiting" : "running";
};

/** A hob's Tasks on the Quest, in the order they were created: it has at least one. */
type Owned = readonly [Task, ...Array<Task>];

/** One hob's lane, from its Tasks in the order they were created. */
const laneOf = (
  tree: TaskTree,
  hobId: AgentId,
  tasks: Owned,
  role: LaneRole,
  readOf: (id: AttemptId) => AttemptActivity | undefined,
): Lane => {
  const task = tasks.find((each) => !isTerminalTask(each.state)) ?? tasks[tasks.length - 1] ?? tasks[0];
  const sections = tasks.map((each) => ({ task: each, ...sectionOf(tree, each, readOf) }));
  const items = sections.flatMap((section) =>
    tasks.length > 1
      ? [{ kind: "task", key: `task-${section.task.id}`, title: taskTitle(section.task) } as const, ...section.items]
      : section.items,
  );
  const current = sections.find((section) => section.task.id === task.id)?.unit ?? [task];
  const waitingOn = roomRows(tree).find((row) => row.task.id === task.id)?.waitingOn ?? [];
  const tail: Array<LaneItem> = [];
  if (!isTerminalTask(task.state) && waitingOn.length > 0)
    tail.push({ kind: "wait", key: `wait-${task.id}`, on: waitingOn });
  const now = nowItem(tree, current, readOf);
  if (now !== null) tail.push(now);
  return {
    hobId,
    role,
    task,
    title: taskTitle(task),
    status: laneStatus(tree, current, task),
    items: [...foldMarks(items), ...tail],
  };
};

/**
 * The room's lanes for a request's Task tree: one per hob, each under the hob that brought it in.
 * `activities` are the Workbench records of the tree's Attempts that have been read; an Attempt not
 * read yet adds only what the tree itself records.
 */
export const laneRoom = (tree: TaskTree, activities: ReadonlyArray<AttemptActivity>): LaneRoom => {
  const top = tree.tasks[0];
  if (top === undefined) return { lanes: [], order: [] };
  const reads = new Map(activities.map((each) => [each.attempt.id, each]));
  const readOf = (id: AttemptId) => reads.get(id);
  // A hob keeps one lane, under the hob that brought it in first.
  const owned = new Map<AgentId, { tasks: Owned; lead: AgentId | null }>();
  for (const task of tree.tasks) {
    if (isStep(tree, task)) continue;
    const entry = owned.get(task.ownerId);
    owned.set(task.ownerId, {
      tasks: entry === undefined ? [task] : [...entry.tasks, task],
      lead: entry === undefined ? leadOf(tree, task) : entry.lead,
    });
  }
  const membersOf = (hobId: AgentId) =>
    [...owned.entries()].filter(([id, entry]) => entry.lead === hobId && id !== top.ownerId).map(([id]) => id);
  const node = (hobId: AgentId, tasks: Owned, seen: ReadonlySet<AgentId>): LaneNode => {
    const isLead = hobId === top.ownerId;
    const members = membersOf(hobId).filter((id) => !seen.has(id) || isLead);
    const role: LaneRole =
      members.length === 0 ? { kind: "member" } : isLead ? { kind: "lead" } : { kind: "leads", members };
    const next = new Set([...seen, ...members]);
    return { lane: laneOf(tree, hobId, tasks, role, readOf), party: isLead ? [] : nodes(members, next) };
  };
  const nodes = (ids: ReadonlyArray<AgentId>, seen: ReadonlySet<AgentId>): ReadonlyArray<LaneNode> =>
    ids.flatMap((id) => {
      const entry = owned.get(id);
      return entry === undefined ? [] : [node(id, entry.tasks, seen)];
    });
  const party = membersOf(top.ownerId);
  const seen = new Set([top.ownerId, ...party]);
  const lanes = [...nodes([top.ownerId], seen), ...nodes(party, seen)];
  const flatten = (each: LaneNode): ReadonlyArray<Lane> => [each.lane, ...each.party.flatMap(flatten)];
  return { lanes, order: lanes.flatMap(flatten) };
};

/** The element id of a hob's lane, which the lineup scrolls to. */
export const laneDomId = (hobId: AgentId): string => `lane-${hobId}`;
