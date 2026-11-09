import {
  type ApprovalRequest,
  type ArtifactRef,
  Attempt,
  type HobbotsEvent,
  isTerminalTask,
  type Milestone,
  type Quest,
  type Question,
  type Task,
  type TaskControl,
  type TaskId,
  type TaskNote,
  TaskTree,
  type TaskWait,
  type ThreadId,
} from "@hobbots/domain";

/**
 * What the hub answered a Task control with (ADR 018): the tree as it recorded the change.
 * The client applies it before the change's events arrive, as it applies each of them, so whichever
 * comes first the tree ends as the newest copy of each Task says, its Delegation included.
 */
interface ControlRecorded {
  readonly _tag: "ControlRecorded";
  readonly tree: TaskTree;
}

/**
 * A newer version of an approval request, from its journal event or the answer to a decision: a
 * Task's turn waits on its pending requests, so the tree holds them (#698).
 */
interface ApprovalRecorded {
  readonly _tag: "ApprovalRecorded";
  readonly approval: ApprovalRequest;
}

/** The journal events that change a Task tree (ADR 018), a control's answer and an approval's new version. */
export type TaskEvent =
  | ControlRecorded
  | ApprovalRecorded
  | Extract<
      HobbotsEvent,
      {
        readonly _tag:
          | "TaskCreated"
          | "TaskStateChanged"
          | "AttemptReadWeb"
          | "QuestStarted"
          | "CheckpointRecorded"
          | "QuestionAsked"
          | "QuestionAnswered"
          | "QuestionEscalated"
          | "QuestionWithdrawn"
          | "NoteLeft"
          | "NotePickedUp"
          | "HandedOff"
          | "TaskCompleted"
          | "QuestCompleted"
          | "ToolCallRefused";
      }
    >;

type Versioned = { readonly id: string; readonly revision: number };

/** Puts `item` in place of the version with its id, unless that one is newer; a new id goes last. */
const upsertNewer = <T extends Versioned>(list: ReadonlyArray<T>, item: T): ReadonlyArray<T> => {
  const index = list.findIndex((each) => each.id === item.id);
  if (index === -1) return [...list, item];
  const known = list[index] as T;
  return item.revision >= known.revision ? list.with(index, item) : list;
};

/** Records with no revision of their own: the arriving copy replaces the known one. */
const upsert = <T extends { readonly id: string }>(list: ReadonlyArray<T>, item: T): ReadonlyArray<T> => {
  const index = list.findIndex((each) => each.id === item.id);
  return index === -1 ? [...list, item] : list.with(index, item);
};

/** A reached milestone never goes back to unreached, whichever copy arrives last. */
const upsertMilestone = (list: ReadonlyArray<Milestone>, item: Milestone): ReadonlyArray<Milestone> => {
  const known = list.find((each) => each.id === item.id);
  return known?.reachedAt != null && item.reachedAt === null ? list : upsert(list, item);
};

const upsertArtifacts = (
  list: ReadonlyArray<ArtifactRef>,
  items: ReadonlyArray<ArtifactRef>,
  ids: ReadonlySet<TaskId>,
): ReadonlyArray<ArtifactRef> => items.filter((item) => ids.has(item.taskId)).reduce(upsert, list);

/**
 * Applies a Task's new version and, when it is not older than the one known, the Attempt that came
 * with it, so a replayed event never moves an Attempt back.
 */
const withTask = (tree: TaskTree, task: Task, attempt: Attempt | null): Partial<TaskTree> => {
  const known = tree.tasks.find((each) => each.id === task.id);
  const fresh = known === undefined || task.revision >= known.revision;
  return {
    tasks: upsertNewer(tree.tasks, task),
    attempts: attempt !== null && fresh ? upsert(tree.attempts, attempt) : tree.attempts,
  };
};

/**
 * A Task's new wait replaces the one it had, unless the change is older than the Task known. A Task
 * that ended waits for nothing, as the hub drops its wait (#702).
 */
const withWait = (
  tree: TaskTree,
  event: { readonly task: Task; readonly wait: TaskWait | null },
): Partial<TaskTree> => {
  const { wait, task } = event;
  const known = tree.tasks.find((each) => each.id === task.id);
  if (known !== undefined && task.revision < known.revision) return {};
  const others = tree.waits.filter((each) => each.taskId !== task.id);
  if (isTerminalTask(task.state)) return others.length === tree.waits.length ? {} : { waits: others };
  return wait === null ? {} : { waits: [...others, wait] };
};

/**
 * A retry or reassignment from the task sheet carries the Task's Delegation as it now is: after a
 * reassignment it names the new member, so the party follows.
 */
const withControl = (
  tree: TaskTree,
  event: { readonly task: Task; readonly control?: TaskControl | undefined },
): Partial<TaskTree> => {
  const delegation = event.control?.delegation ?? null;
  const known = tree.tasks.find((each) => each.id === event.task.id);
  if (delegation === null || (known !== undefined && event.task.revision < known.revision)) return {};
  return { delegations: upsert(tree.delegations, delegation) };
};

const withQuest = (tree: TaskTree, quest: Quest | null, ids: ReadonlySet<TaskId>): Partial<TaskTree> =>
  quest !== null && ids.has(quest.taskId) ? { quests: upsertNewer(tree.quests, quest) } : {};

type Change<T extends TaskEvent["_tag"]> = (
  tree: TaskTree,
  event: Extract<TaskEvent, { readonly _tag: T }>,
  ids: ReadonlySet<TaskId>,
) => Partial<TaskTree> | null;

const questionChange = (
  tree: TaskTree,
  event: { readonly question: Question },
  ids: ReadonlySet<TaskId>,
): Partial<TaskTree> | null =>
  ids.has(event.question.taskId) ? { questions: upsertNewer(tree.questions, event.question) } : null;

const noteChange = (tree: TaskTree, { note }: { readonly note: TaskNote }, ids: ReadonlySet<TaskId>) =>
  ids.has(note.taskId) ? { notes: upsertNewer(tree.notes, note) } : null;

const questChange = (
  tree: TaskTree,
  event: { readonly quest: Quest },
  ids: ReadonlySet<TaskId>,
): Partial<TaskTree> | null => (ids.has(event.quest.taskId) ? withQuest(tree, event.quest, ids) : null);

/**
 * One Task of a control's answer applied as its change would be, with the Delegation the answer
 * holds for it, unless the tree already knows a newer copy of the Task.
 */
const withRecorded = (tree: TaskTree, task: Task, recorded: TaskTree, ids: ReadonlySet<TaskId>): TaskTree => {
  const known = tree.tasks.find((each) => each.id === task.id);
  const fresh = known === undefined || task.revision >= known.revision;
  const delegation = recorded.delegations.find((each) => each.childTaskId === task.id);
  return new TaskTree({
    ...tree,
    ...withTask(tree, task, recorded.attempts.find((each) => each.id === task.currentAttemptId) ?? null),
    ...withQuest(tree, recorded.quests.find((each) => each.taskId === task.id) ?? null, ids),
    ...withWait(tree, { task, wait: recorded.waits.find((each) => each.taskId === task.id) ?? null }),
    ...(fresh && delegation !== undefined ? { delegations: upsert(tree.delegations, delegation) } : {}),
  });
};

/** What each event changes in a tree it belongs to, or null for an event about another tree. */
const CHANGES: { readonly [T in TaskEvent["_tag"]]: Change<T> } = {
  ControlRecorded: (tree, { tree: recorded }, ids) => {
    const mine = recorded.tasks.filter((task) => ids.has(task.id));
    return mine.length === 0 ? null : mine.reduce((next, task) => withRecorded(next, task, recorded, ids), tree);
  },
  TaskCreated: (tree, { task, delegation, milestones }, ids) =>
    ids.has(task.id) || (task.parentId !== null && ids.has(task.parentId))
      ? {
          tasks: upsertNewer(tree.tasks, task),
          delegations: delegation === null ? tree.delegations : upsert(tree.delegations, delegation),
          milestones: milestones.reduce(upsertMilestone, tree.milestones),
        }
      : null,
  TaskStateChanged: (tree, event, ids) =>
    ids.has(event.task.id)
      ? {
          ...withTask(tree, event.task, event.attempt),
          ...withQuest(tree, event.quest, ids),
          ...withWait(tree, event),
          ...withControl(tree, event),
        }
      : null,
  // Only the mark changes: the Attempt's state stays as the tree knows it, whichever came last.
  AttemptReadWeb: (tree, { taskId, attempt }, ids) => {
    if (!ids.has(taskId) || !tree.attempts.some((each) => each.id === attempt.id)) return null;
    return {
      attempts: tree.attempts.map((each) =>
        each.id === attempt.id ? new Attempt({ ...each, readWeb: attempt.readWeb ?? null }) : each,
      ),
    };
  },
  TaskCompleted: (tree, event, ids) =>
    ids.has(event.task.id)
      ? {
          ...withTask(tree, event.task, null),
          ...withWait(tree, { task: event.task, wait: null }),
          artifacts: upsertArtifacts(tree.artifacts, event.artifacts, ids),
        }
      : null,
  QuestStarted: questChange,
  QuestCompleted: questChange,
  CheckpointRecorded: (tree, { checkpoint, milestone }, ids) =>
    ids.has(checkpoint.taskId)
      ? {
          checkpoints: [...upsertNewer(tree.checkpoints, checkpoint)].sort((a, b) => a.revision - b.revision),
          milestones: milestone === null ? tree.milestones : upsertMilestone(tree.milestones, milestone),
        }
      : null,
  QuestionAsked: questionChange,
  QuestionAnswered: questionChange,
  QuestionEscalated: questionChange,
  QuestionWithdrawn: questionChange,
  NoteLeft: noteChange,
  NotePickedUp: noteChange,
  // An older copy changes nothing, so the tree stays the same.
  ApprovalRecorded: (tree, { approval }, ids) => {
    if (approval.taskId === null || !ids.has(approval.taskId)) return null;
    const known = tree.approvals.find((each) => each.id === approval.id);
    return known !== undefined && known.revision >= approval.revision
      ? null
      : { approvals: upsertNewer(tree.approvals, approval) };
  },
  // A refusal tried again replaces its record, unless the copy known was refused later.
  ToolCallRefused: (tree, { refusal }, ids) => {
    if (refusal.taskId === null || !ids.has(refusal.taskId)) return null;
    const known = tree.refusals.find((each) => each.id === refusal.id);
    return known !== undefined && known.tries > refusal.tries ? null : { refusals: upsert(tree.refusals, refusal) };
  },
  HandedOff: (tree, { handOff, artifact }, ids) => {
    if (!ids.has(handOff.toTaskId) && !ids.has(artifact.taskId)) return null;
    const known = tree.handOffs.some(
      (each) => each.artifactId === handOff.artifactId && each.toTaskId === handOff.toTaskId,
    );
    return {
      artifacts: upsertArtifacts(tree.artifacts, [artifact], ids),
      handOffs: known || !ids.has(handOff.toTaskId) ? tree.handOffs : [...tree.handOffs, handOff],
    };
  },
};

/**
 * A Task tree with a journal event applied. Applying an event twice, or an event older than what
 * the tree holds, changes nothing, so a read and the events replayed after its cursor can arrive in
 * either order (ADR 013). An event about another tree returns the same tree.
 */
export const applyToTree = (tree: TaskTree, event: TaskEvent): TaskTree => {
  const ids = new Set(tree.tasks.map((task) => task.id));
  const changed = (CHANGES[event._tag] as Change<TaskEvent["_tag"]>)(tree, event, ids);
  return changed === null ? tree : new TaskTree({ ...tree, ...changed });
};

/** A tree for a Task just created on its own: a request's new top Task. */
const newTree = (task: Task, milestones: ReadonlyArray<Milestone>): TaskTree =>
  new TaskTree({
    tasks: [task],
    quests: [],
    delegations: [],
    attempts: [],
    milestones,
    checkpoints: [],
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: [],
  });

/**
 * A thread's Task trees with an event applied: a top Task started in the thread adds its tree, and
 * every other event goes to the tree it belongs to.
 */
export const applyToThreadTrees = (
  threadId: ThreadId,
  trees: ReadonlyArray<TaskTree>,
  event: TaskEvent,
): ReadonlyArray<TaskTree> => {
  if (event._tag === "TaskCreated" && event.task.parentId === null) {
    const { task } = event;
    const known = trees.some((tree) => tree.tasks[0]?.id === task.id);
    if (task.threadId === threadId && !known) return [...trees, newTree(task, event.milestones)];
  }
  const next = trees.map((tree) => applyToTree(tree, event));
  return next.every((tree, index) => tree === trees[index]) ? trees : next;
};
