import {
  type AgentId,
  type ApprovalRequest,
  type ArtifactRef,
  type Attempt,
  type AttemptActivity,
  type Checkpoint,
  descendantsOf,
  type FileChange,
  type Milestone,
  type Question,
  type Task,
  type TaskResult,
  type TaskState,
  type TaskTree,
} from "@hobbots/domain";

/**
 * What the Summary tab says about one Task (ADR 023): what it was asked, what happened, what it
 * made, what is still open and its result. Everything comes from the hub's records, never from a
 * model call or from what a hob wrote about itself (STD-UI-008).
 */

/** Where a line of What happened stands. */
export type Mark = "done" | "failed" | "waiting" | "running" | "next" | "cancelled";

export type HappenedLine =
  /** One of the Task's own steps, as "Step 2 of 4", with how many tries it took. */
  | {
      readonly kind: "step";
      readonly task: Task;
      readonly index: number;
      readonly total: number;
      readonly tries: number;
      readonly mark: Mark;
    }
  /** A party member's Task under this one. */
  | { readonly kind: "member"; readonly task: Task; readonly tries: number; readonly mark: Mark }
  /** Something the Task's owner reported: a finding, a blocker, a question or progress. */
  | { readonly kind: "checkpoint"; readonly checkpoint: Checkpoint; readonly mark: Mark }
  /** A milestone the brief planned: reached, or still next. */
  | { readonly kind: "milestone"; readonly milestone: Milestone; readonly mark: Mark }
  /** The chosen Attempt ended without finishing the Task, with why when the hub knows. */
  | { readonly kind: "ended"; readonly attempt: Attempt; readonly mark: Mark };

/** A file the Attempt changed, by its absolute path: the file's folder and its path inside it. */
interface ChangedFile {
  readonly change: FileChange;
  readonly path: string;
}

export interface Summary {
  readonly asked: {
    readonly brief: string;
    /** The lead whose brief it is, for a member's Task; null for a Task you asked for. */
    readonly from: AgentId | null;
    readonly expected: string | null;
  };
  readonly happened: ReadonlyArray<HappenedLine>;
  readonly made: {
    readonly artifacts: ReadonlyArray<ArtifactRef>;
    readonly changes: ReadonlyArray<ChangedFile>;
  };
  readonly open: {
    /** Questions nobody has answered yet, from this Task or any under it. */
    readonly questions: ReadonlyArray<Question>;
    /** Tool calls in this Task's work that wait for your decision. */
    readonly approvals: ReadonlyArray<ApprovalRequest>;
  };
  readonly result: TaskResult | null;
  /** How much of each other tab the Attempt used, for the buttons at the end. */
  readonly used: { readonly changes: number; readonly files: number; readonly commands: number };
}

/** A change's file as one absolute path, the key Changes and Files select a file by. */
export const changePath = (change: Pick<FileChange, "folder" | "path">): string => `${change.folder}/${change.path}`;

export const markOf = (state: TaskState): Mark => {
  switch (state) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "waiting":
    case "blocked":
      return "waiting";
    case "queued":
      return "next";
    default:
      return "running";
  }
};

const CHECKPOINT_MARK: Readonly<Record<Checkpoint["kind"], Mark>> = {
  milestone: "done",
  finding: "done",
  progress: "done",
  blocker: "waiting",
  question: "waiting",
  started: "done",
  waiting: "waiting",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const ENDED_EARLY: ReadonlySet<Attempt["state"]> = new Set(["failed", "interrupted", "cancelled", "unresolved"]);

/** A line and the time it goes at; a line with no time yet goes last, in its own order. */
interface Timed {
  readonly at: string;
  readonly line: HappenedLine;
}

/** The Task's steps and its members' Tasks, at the time each was made. */
const childLines = (tree: TaskTree, task: Task): Array<Timed> => {
  const children = tree.tasks.filter((each) => each.parentId === task.id);
  const steps = children.filter((each) => each.ownerId === task.ownerId);
  const tries = (child: Task) => tree.attempts.filter((each) => each.taskId === child.id).length;
  return children.map((child) => ({
    at: child.createdAt,
    line:
      child.ownerId === task.ownerId
        ? {
            kind: "step",
            task: child,
            index: steps.indexOf(child) + 1,
            total: steps.length,
            tries: tries(child),
            mark: markOf(child.state),
          }
        : { kind: "member", task: child, tries: tries(child), mark: markOf(child.state) },
  }));
};

/**
 * What the Task's owner reported in the chosen Attempt, or with no Attempt named. A reached
 * milestone is its milestone's line, and the hub's own states only repeat the Task's.
 */
const reportLines = (
  tree: TaskTree,
  task: Task,
  attempt: Attempt | null,
  milestones: ReadonlyArray<Milestone>,
): Array<Timed> =>
  tree.checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.taskId === task.id &&
        checkpoint.source !== "automatic" &&
        !(checkpoint.kind === "milestone" && milestones.some((each) => each.id === checkpoint.milestoneId)) &&
        (attempt === null || checkpoint.attemptId === null || checkpoint.attemptId === attempt.id),
    )
    .map((checkpoint) => ({
      at: checkpoint.createdAt,
      line: { kind: "checkpoint", checkpoint, mark: CHECKPOINT_MARK[checkpoint.kind] },
    }));

/**
 * What happened, in order: the Task's steps and its members' Tasks, what its owner reported in the
 * chosen Attempt, the milestones it reached, then those still ahead, and how the Attempt ended
 * when it ended without finishing.
 */
const happenedOf = (tree: TaskTree, task: Task, attempt: Attempt | null): ReadonlyArray<HappenedLine> => {
  const milestones = tree.milestones.filter((each) => each.taskId === task.id).sort((a, b) => a.position - b.position);
  const reached: Array<Timed> = milestones.flatMap((milestone) =>
    milestone.reachedAt === null
      ? []
      : [{ at: milestone.reachedAt, line: { kind: "milestone", milestone, mark: "done" } }],
  );
  const timed = [...childLines(tree, task), ...reportLines(tree, task, attempt, milestones), ...reached];
  // A stable sort keeps lines that share a time, such as steps planned together, in their order.
  const lines = timed.sort((a, b) => a.at.localeCompare(b.at)).map((each) => each.line);
  for (const milestone of milestones) {
    if (milestone.reachedAt === null) lines.push({ kind: "milestone", milestone, mark: "next" });
  }
  if (attempt !== null && ENDED_EARLY.has(attempt.state)) {
    lines.push({ kind: "ended", attempt, mark: attempt.state === "failed" ? "failed" : "cancelled" });
  }
  return lines;
};

/** The Attempt's changed files, one per file at its latest record, by path. */
const changedFiles = (activity: AttemptActivity | null): ReadonlyArray<ChangedFile> => {
  const latest = new Map<string, FileChange>();
  for (const change of activity?.changes ?? []) latest.set(changePath(change), change);
  return [...latest]
    .map(([path, change]) => ({ path, change }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/**
 * Whether an approval belongs to this Task's work: asked in a turn of this Task or one under it,
 * or, for the Task you asked for, in the chat turn that works on it.
 */
const approvalFor = (approval: ApprovalRequest, task: Task, under: ReadonlySet<string>): boolean =>
  approval.state === "pending" &&
  (approval.taskId === null ? task.parentId === null && approval.rootTaskId === task.id : under.has(approval.taskId));

/**
 * The Summary of a Task for the chosen Attempt. `approvals` are the thread's requests, whatever
 * their state. What it made follows the chosen Attempt; its brief, what is still open and its
 * result are the Task's.
 */
export const summaryOf = (
  tree: TaskTree,
  task: Task,
  attempt: Attempt | null,
  activity: AttemptActivity | null,
  approvals: ReadonlyArray<ApprovalRequest>,
): Summary => {
  const delegation = tree.delegations.find((each) => each.childTaskId === task.id) ?? null;
  const under = new Set<string>([task.id, ...descendantsOf(task, tree.tasks).map((each) => each.id)]);
  const artifacts = tree.artifacts.filter(
    (each) => each.taskId === task.id && (attempt === null || each.attemptId === attempt.id),
  );
  const changes = changedFiles(activity);
  return {
    asked: {
      brief: delegation?.brief ?? task.brief,
      from: delegation?.leadId ?? null,
      expected: delegation?.expectedOutput ?? null,
    },
    happened: happenedOf(tree, task, attempt),
    made: { artifacts, changes },
    open: {
      questions: tree.questions.filter((each) => each.state === "open" && under.has(each.taskId)),
      approvals: approvals.filter((each) => approvalFor(each, task, under)),
    },
    result: task.result,
    used: {
      changes: changes.length,
      // A file it made and also changed is one file.
      files: new Set([
        ...artifacts.filter((each) => each.kind === "file").map((each) => each.value),
        ...changes.filter((each) => each.change.after !== null && each.change.kind !== "link").map((each) => each.path),
      ]).size,
      commands: activity?.commands.length ?? 0,
    },
  };
};

/** The ids of a Task and every Task under it, the scope of its backpack items. */
export const subtreeScope = (tree: TaskTree, task: Task) => {
  const tasks = [task, ...descendantsOf(task, tree.tasks)];
  const taskIds = new Set<string>(tasks.map((each) => each.id));
  return {
    kind: "tree",
    taskIds,
    questIds: new Set<string>(tree.quests.filter((each) => taskIds.has(each.taskId)).map((each) => each.id)),
  } as const;
};
