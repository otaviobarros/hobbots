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
  TASK_TOOLS,
  type Task,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { blockedLine, changeLine, commandLine, type StepOutcome, stepDoing } from "../plain-words/plain-words.ts";
import { type RoomStatus, roomRows, roomStatus } from "../quest/control-room.ts";
import { questionForYou, taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

/** Why the hub refused a hob's Task tool call, in a few words, or nothing for a reason only the hob needs. */
const refusalReason = (reason: string): string =>
  Object.hasOwn(messages.refusal, reason) ? messages.refusal[reason as keyof typeof messages.refusal] : "";

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
type LaneWaited = { readonly kind: "hob"; readonly id: AgentId } | { readonly kind: "you" };

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

/** Something the hob did, in everyday words in place of a mark (ADR 027), with how it went. */
export interface LaneStep {
  readonly kind: "step";
  readonly key: string;
  readonly text: string;
  readonly outcome: StepOutcome;
}

/** What folds into a count: marks, or the steps that stand for them in everyday words. */
export type LaneFoldable = LaneMark | LaneStep;

/** What a lane shows, in its order. */
export type LaneItem =
  | LaneMark
  | LaneStep
  /** A milestone, finding or report the hob made, or a finding the hub made about its Task. */
  | { readonly kind: "beat"; readonly key: string; readonly text: string }
  /**
   * A tool call that was refused, with what the hob was told. `plain` says it in everyday words, or
   * is null for a refusal that is only the hub keeping order, which the hob goes on after.
   */
  | {
      readonly kind: "refused";
      readonly key: string;
      readonly what: string;
      readonly reason: string;
      readonly plain: string | null;
    }
  /** Older marks, folded into a count so a long lane stays readable. */
  | { readonly kind: "folded"; readonly key: string; readonly marks: ReadonlyArray<LaneFoldable> }
  | { readonly kind: "hand-out"; readonly key: string; readonly label: string; readonly to: AgentId }
  | { readonly kind: "hand-in"; readonly key: string; readonly label: string; readonly from: AgentId }
  | { readonly kind: "briefed"; readonly key: string; readonly members: ReadonlyArray<AgentId> }
  /** Where a hob with more than one Task on the Quest starts the next. */
  | { readonly kind: "task"; readonly key: string; readonly title: string }
  | { readonly kind: "wait"; readonly key: string; readonly on: ReadonlyArray<LaneWaited> }
  /**
   * A turn runs now: the step it is on, or null before it reported one. `since` is when the room last
   * recorded anything the hob did on the Task, so a lane that has gone quiet says for how long (#1004).
   */
  | {
      readonly kind: "now";
      readonly key: string;
      readonly label: string | null;
      readonly plain: string | null;
      readonly since: string;
    }
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
  /** Every Task the hob owns on the Quest, in the order they were created, without its steps. */
  readonly tasks: ReadonlyArray<Task>;
  readonly title: string;
  readonly status: RoomStatus;
  /** What the hob did, with its exact marks: the technical steps. */
  readonly items: ReadonlyArray<LaneItem>;
  /** The same in everyday words: no commands, reads left out, each refusal that matters once. */
  readonly plain: ReadonlyArray<LaneItem>;
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

/** The try picked for a Task in the room, by its Task: the lane shows that try in place of the latest. */
export type LanePicks = ReadonlyMap<TaskId, AttemptId>;

const NO_PICKS: LanePicks = new Map();

/** The Attempt a Task's lane shows: the one picked for it, else its latest. */
const shownAttempt = (tree: TaskTree, task: Task, picks: LanePicks): Attempt | undefined => {
  const attempts = tree.attempts.filter((each) => each.taskId === task.id);
  const picked = picks.get(task.id);
  return (
    attempts.find((each) => each.id === picked) ??
    attempts.reduce<Attempt | undefined>(
      (latest, each) => (latest === undefined || each.number > latest.number ? each : latest),
      undefined,
    )
  );
};

/**
 * The Attempts whose Workbench records the lanes show, for the room to read: the shown try of every
 * Task in the tree, and the running one of a Task that runs, which says the step it is on.
 */
export const laneAttempts = (tree: TaskTree, picks: LanePicks = NO_PICKS): ReadonlyArray<AttemptId> => [
  ...new Set(
    tree.tasks.flatMap((task) => {
      const shown = shownAttempt(tree, task, picks)?.id;
      return [shown, task.currentAttemptId].filter((id): id is AttemptId => id !== undefined && id !== null);
    }),
  ),
];

/** The Workbench records the room has read, and the tries picked in it. */
type Reads = { readonly of: (id: AttemptId) => AttemptActivity | undefined; readonly picks: LanePicks };

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
      const item = {
        kind: "refused",
        key: `step-${step.id}`,
        what: step.label,
        reason: step.reason ?? "",
        plain: blockedLine(step),
      } as const;
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

/**
 * The Task tool calls the hub refused for the Task, in your words: the tool's own label, and why in
 * a few words where the reason has some. The message the hub sent the hob is for the hob: it names
 * Tasks by id and tells it how to go on.
 */
const refusalItems = (tree: TaskTree, task: Task): ReadonlyArray<Timed> =>
  tree.refusals
    .filter((each) => each.taskId === task.id)
    .map((each) => ({
      at: each.refusedAt,
      item: {
        kind: "refused",
        key: `refusal-${each.id}`,
        what: TASK_TOOLS.find((tool) => tool.name === each.tool)?.label ?? each.tool,
        reason: refusalReason(each.reason),
        plain: null,
      },
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
 * Folds every mark but the last `shown` into one count for each Task's part of the lane, placed
 * where its first hidden mark was: a long run of work reads as one "N more" instead of several.
 * Beats, chips, refused calls, results and Task headings stay where they happened, and no mark
 * moves into another Task's part of the lane.
 */
export const foldMarks = (items: ReadonlyArray<LaneItem>, shown: number = SHOWN_MARKS): ReadonlyArray<LaneItem> => {
  const isMark = (item: LaneItem): item is LaneFoldable =>
    item.kind === "read" ||
    item.kind === "edit" ||
    item.kind === "delete" ||
    item.kind === "run" ||
    item.kind === "step";
  const marks = items.filter(isMark);
  const hidden = new Set<LaneItem>(marks.slice(0, Math.max(0, marks.length - shown)));
  if (hidden.size === 0) return items;
  const folded: Array<LaneItem> = [];
  let fold: { kind: "folded"; key: string; marks: Array<LaneFoldable> } | null = null;
  for (const item of items) {
    if (item.kind === "task") fold = null;
    if (!isMark(item) || !hidden.has(item)) {
      folded.push(item);
    } else if (fold === null) {
      fold = { kind: "folded", key: `folded-${item.key}`, marks: [item] };
      folded.push(fold);
    } else {
      fold.marks.push(item);
    }
  }
  return folded;
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
const sectionOf = (tree: TaskTree, task: Task, read: Reads) => {
  const unit = unitOf(tree, task);
  const timed = unit.flatMap((each) => {
    const attempt = shownAttempt(tree, each, read.picks);
    const activity = attempt === undefined ? undefined : read.of(attempt.id);
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

/** The latest of some times in ISO 8601, which sort as text. */
const latest = (times: ReadonlyArray<string>): string =>
  times.reduce((last, each) => (last.localeCompare(each) < 0 ? each : last));

/**
 * When the room last recorded something the hob did on its running Task: the turn starting, a step,
 * a command starting or ending, a file change, a beat, a refused call or a brief.
 */
const lastActivity = (tree: TaskTree, unit: ReadonlyArray<Task>, attempt: Attempt, activity?: AttemptActivity) => {
  const ids: ReadonlySet<TaskId | null> = new Set(unit.map((each) => each.id));
  return latest([
    attempt.startedAt,
    ...(activity?.steps.flatMap((each) => (each.startedAt === undefined ? [] : [each.startedAt])) ?? []),
    ...(activity?.commands.flatMap((each) => [each.startedAt, ...(each.endedAt === null ? [] : [each.endedAt])]) ?? []),
    ...(activity?.changes.map((each) => each.recordedAt) ?? []),
    ...tree.checkpoints.filter((each) => ids.has(each.taskId)).map((each) => each.createdAt),
    ...tree.refusals.filter((each) => ids.has(each.taskId)).map((each) => each.refusedAt),
    ...tree.delegations.filter((each) => ids.has(each.parentTaskId)).map((each) => each.createdAt),
  ]);
};

/** The step a running turn is on, from the records of the Attempt that runs, and when the hob last did something. */
const nowItem = (tree: TaskTree, unit: ReadonlyArray<Task>, read: Reads): LaneItem | null => {
  const running = unit.find((each) => liveAttemptOn(each, tree));
  const attempt = tree.attempts.find((each) => each.id === running?.currentAttemptId);
  if (running === undefined || attempt === undefined) return null;
  const activity = read.of(attempt.id);
  const step = activity?.steps.findLast((each) => each.state === "running");
  return {
    kind: "now",
    key: `now-${running.id}`,
    label: step?.label ?? null,
    plain: step === undefined ? null : stepDoing(step),
    since: lastActivity(tree, unit, attempt, activity),
  };
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

/** One lane item in everyday words, or null for one a lane leaves out then. */
const plainItem = (item: LaneItem): LaneItem | null => {
  const step = (text: string, outcome: StepOutcome): LaneStep => ({ kind: "step", key: item.key, text, outcome });
  switch (item.kind) {
    case "read":
      return null;
    case "edit":
      return step(changeLine(item.change.kind, item.path), "done");
    case "delete":
      return step(changeLine("deleted", item.path), "done");
    case "run": {
      const line = commandLine(item.command);
      return line === null ? null : step(line.text, line.outcome);
    }
    case "refused":
      return item.plain === null ? null : step(item.plain, "blocked");
    case "now":
      return { ...item, label: item.plain };
    default:
      return item;
  }
};

/**
 * A lane in everyday words (ADR 027): what the hob did without commands or the files it only read,
 * and each stopped step once for each of the hob's Tasks, however often the hob tried it again. A
 * stopped step's words name who stopped it and what it wanted to do, so the same words are the same
 * step; every file change and command keeps its own line.
 */
const plainItems = (items: ReadonlyArray<LaneItem>): ReadonlyArray<LaneItem> => {
  const kept: Array<LaneItem> = [];
  let stopped = new Set<string>();
  for (const each of items) {
    if (each.kind === "task") stopped = new Set();
    const item = plainItem(each);
    if (item === null) continue;
    if (item.kind === "step" && item.outcome === "blocked") {
      if (stopped.has(item.text)) continue;
      stopped.add(item.text);
    }
    kept.push(item);
  }
  return kept;
};

/** Who a Task that has not ended waits on, or null when it waits on nobody. */
const waitItem = (task: Task, rows: ReturnType<typeof roomRows>): LaneItem | null => {
  if (isTerminalTask(task.state)) return null;
  const on = rows.find((row) => row.task.id === task.id)?.waitingOn ?? [];
  return on.length === 0 ? null : { kind: "wait", key: `wait-${task.id}`, on };
};

/** A hob's Tasks on the Quest, in the order they were created: it has at least one. */
type Owned = readonly [Task, ...Array<Task>];

/** One hob's lane, from its Tasks in the order they were created. */
const laneOf = (tree: TaskTree, hobId: AgentId, tasks: Owned, role: LaneRole, read: Reads): Lane => {
  const task = tasks.find((each) => !isTerminalTask(each.state)) ?? tasks[tasks.length - 1] ?? tasks[0];
  const rows = roomRows(tree);
  const sections = tasks.map((each) => ({ task: each, ...sectionOf(tree, each, read) }));
  const items = sections.flatMap((section) => {
    // Each Task that has not ended says who it waits on, at the end of its own part of the lane.
    const wait = waitItem(section.task, rows);
    const body = wait === null ? section.items : [...section.items, wait];
    return tasks.length > 1
      ? [{ kind: "task", key: `task-${section.task.id}`, title: taskTitle(section.task) } as const, ...body]
      : body;
  });
  const current = sections.find((section) => section.task.id === task.id)?.unit ?? [task];
  // Every Task the lane holds, with their steps: a question or approval on any of them lights it.
  const owned = sections.flatMap((section) => section.unit);
  const now = nowItem(tree, current, read);
  return {
    hobId,
    role,
    task,
    tasks,
    title: taskTitle(task),
    status: laneStatus(tree, owned, task),
    items: now === null ? foldMarks(items) : [...foldMarks(items), now],
    plain: foldMarks(plainItems(now === null ? items : [...items, now])),
  };
};

/**
 * The room's lanes for a request's Task tree: one per hob, each under the hob that brought it in.
 * `activities` are the Workbench records of the tree's Attempts that have been read; an Attempt not
 * read yet adds only what the tree itself records. `picks` names a try picked for a Task, which its
 * lane shows in place of the latest.
 */
export const laneRoom = (
  tree: TaskTree,
  activities: ReadonlyArray<AttemptActivity>,
  picks: LanePicks = NO_PICKS,
): LaneRoom => {
  const top = tree.tasks[0];
  if (top === undefined) return { lanes: [], order: [] };
  const reads = new Map(activities.map((each) => [each.attempt.id, each]));
  const read: Reads = { of: (id) => reads.get(id), picks };
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
    // A member that started a Quest of its own leads it, even before it brought anyone in.
    const leadsQuest = tree.quests.some((quest) => tasks.some((each) => each.id === quest.taskId));
    const role: LaneRole = isLead
      ? members.length === 0
        ? { kind: "member" }
        : { kind: "lead" }
      : members.length > 0 || leadsQuest
        ? { kind: "leads", members }
        : { kind: "member" };
    const next = new Set([...seen, ...members]);
    return { lane: laneOf(tree, hobId, tasks, role, read), party: isLead ? [] : nodes(members, next) };
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
