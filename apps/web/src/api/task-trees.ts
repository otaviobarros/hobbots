import {
  type ArtifactRef,
  type Attempt,
  type HobbotsEvent,
  type Milestone,
  type Quest,
  type Task,
  type TaskId,
  TaskTree,
  type ThreadId,
} from "@hobbots/domain";

/** The journal events that change a Task tree (ADR 018). */
export type TaskEvent = Extract<
  HobbotsEvent,
  {
    readonly _tag:
      | "TaskCreated"
      | "TaskStateChanged"
      | "QuestStarted"
      | "CheckpointRecorded"
      | "QuestionAsked"
      | "QuestionAnswered"
      | "QuestionEscalated"
      | "HandedOff"
      | "TaskCompleted"
      | "QuestCompleted";
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

const withQuest = (tree: TaskTree, quest: Quest | null, ids: ReadonlySet<TaskId>): Partial<TaskTree> =>
  quest !== null && ids.has(quest.taskId) ? { quests: upsertNewer(tree.quests, quest) } : {};

const changes = (tree: TaskTree, event: TaskEvent, ids: ReadonlySet<TaskId>): Partial<TaskTree> | null => {
  switch (event._tag) {
    case "TaskCreated": {
      const { task, delegation, milestones } = event;
      if (!ids.has(task.id) && (task.parentId === null || !ids.has(task.parentId))) return null;
      return {
        tasks: upsertNewer(tree.tasks, task),
        delegations: delegation === null ? tree.delegations : upsert(tree.delegations, delegation),
        milestones: milestones.reduce(upsertMilestone, tree.milestones),
      };
    }
    case "TaskStateChanged":
      if (!ids.has(event.task.id)) return null;
      return { ...withTask(tree, event.task, event.attempt), ...withQuest(tree, event.quest, ids) };
    case "TaskCompleted":
      if (!ids.has(event.task.id)) return null;
      return { ...withTask(tree, event.task, null), artifacts: upsertArtifacts(tree.artifacts, event.artifacts, ids) };
    case "QuestStarted":
    case "QuestCompleted":
      return ids.has(event.quest.taskId) ? withQuest(tree, event.quest, ids) : null;
    case "CheckpointRecorded": {
      const { checkpoint, milestone } = event;
      if (!ids.has(checkpoint.taskId)) return null;
      return {
        checkpoints: [...upsertNewer(tree.checkpoints, checkpoint)].sort((a, b) => a.revision - b.revision),
        milestones: milestone === null ? tree.milestones : upsertMilestone(tree.milestones, milestone),
      };
    }
    case "QuestionAsked":
    case "QuestionAnswered":
    case "QuestionEscalated":
      return ids.has(event.question.taskId) ? { questions: upsertNewer(tree.questions, event.question) } : null;
    case "HandedOff": {
      const { handOff, artifact } = event;
      if (!ids.has(handOff.toTaskId) && !ids.has(artifact.taskId)) return null;
      const known = tree.handOffs.some(
        (each) => each.artifactId === handOff.artifactId && each.toTaskId === handOff.toTaskId,
      );
      return {
        artifacts: upsertArtifacts(tree.artifacts, [artifact], ids),
        handOffs: known || !ids.has(handOff.toTaskId) ? tree.handOffs : [...tree.handOffs, handOff],
      };
    }
  }
};

/**
 * A Task tree with a journal event applied. Applying an event twice, or an event older than what
 * the tree holds, changes nothing, so a read and the events replayed after its cursor can arrive in
 * either order (ADR 013). An event about another tree returns the same tree.
 */
export const applyToTree = (tree: TaskTree, event: TaskEvent): TaskTree => {
  const ids = new Set(tree.tasks.map((task) => task.id));
  const changed = changes(tree, event, ids);
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
