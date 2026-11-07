import {
  type AgentId,
  type ApprovalRequest,
  type ArtifactRef,
  type Attempt,
  type AttemptActivity,
  type Checkpoint,
  descendantsOf,
  type FileChange,
  isLiveAttempt,
  isTerminalTask,
  type Milestone,
  type Question,
  type RefusedCall,
  type ReplyStep,
  saysMore,
  type Task,
  type TaskResult,
  type TaskState,
  type TaskTree,
} from "@hobbots/domain";
import { questionForYou } from "../../quest/work-model.ts";

/**
 * What the Summary tab says about one Task (ADR 023): what it was asked, what happened, what it
 * made, what is still open and its result. Everything comes from the hub's records, never from a
 * model call or from what a hob wrote about itself (STD-UI-008).
 */

/** Where a line of What happened stands. */
export type Mark = "done" | "failed" | "waiting" | "running" | "next" | "cancelled" | "unresolved";

/** How an Attempt that ended without finishing is marked. */
type EndedMark = Extract<Mark, "failed" | "cancelled" | "unresolved">;

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
  /**
   * A milestone the brief planned: reached, or still next. `by` is the hob whose work reached it when
   * that is not the Task's owner (#743), such as its lead making a commit the owner could not.
   */
  | {
      readonly kind: "milestone";
      readonly milestone: Milestone;
      readonly by: AgentId | null;
      readonly mark: Mark;
    }
  /** A Task tool call the hub refused on this Task, with how many times it was tried (#575). */
  | { readonly kind: "refused"; readonly refusal: RefusedCall; readonly mark: Mark }
  /** A tool call of the Attempt's own turns, as a step's or a party member's turn recorded it (#892). */
  | { readonly kind: "tool"; readonly step: ReplyStep; readonly mark: Mark }
  /** The chosen Attempt ended without finishing the Task, with why when the hub knows. */
  | { readonly kind: "ended"; readonly attempt: Attempt; readonly mark: Mark };

/** A file the Attempt changed, by its absolute path: the file's folder and its path inside it. */
interface ChangedFile {
  readonly change: FileChange;
  readonly path: string;
}

/**
 * The one line Summary leads with, from the records: the Task's result once it has one, else where
 * the Attempt shown stands. `earlier` counts the Attempts before it that ended without finishing.
 */
export type SummaryLine = (
  | { readonly kind: "result"; readonly summary: string; readonly from: number | null }
  | { readonly kind: "not-started" }
  /** A question waits for your answer in its lane in the Quest room. */
  | { readonly kind: "asks"; readonly asker: AgentId }
  | { readonly kind: "working"; readonly attempt: number }
  | { readonly kind: "waiting"; readonly attempt: number }
  | { readonly kind: "ended"; readonly attempt: number; readonly mark: EndedMark }
  | { readonly kind: "no-result" }
) & { readonly earlier: number };

export interface Summary {
  readonly line: SummaryLine;
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
    /**
     * Questions nobody has answered yet, from this Task or any under it, except the one the task
     * chat holds: that one is answered there, so it shows only once.
     */
    readonly questions: ReadonlyArray<Question>;
    /** Tool calls in this Task's work that wait for your decision. */
    readonly approvals: ReadonlyArray<ApprovalRequest>;
    /** What this Task or one under it left uncommitted in a Git repository when it completed (#586). */
    readonly uncommitted: ReadonlyArray<Checkpoint>;
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
  uncommitted: "waiting",
};

const ENDED_EARLY: ReadonlySet<Attempt["state"]> = new Set(["failed", "interrupted", "cancelled", "unresolved"]);

/**
 * How an Attempt that ended early is marked. `unresolved` is a stop Hobbots asked for and could not
 * confirm (OR-006): whether its session stopped is not known, so it is never shown as stopped.
 */
const endedMark = (state: Attempt["state"]): EndedMark =>
  state === "failed" ? "failed" : state === "unresolved" ? "unresolved" : "cancelled";

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
        saysMore(checkpoint) &&
        // What it left uncommitted is still open, not something that happened.
        checkpoint.kind !== "uncommitted" &&
        !(checkpoint.kind === "milestone" && milestones.some((each) => each.id === checkpoint.milestoneId)) &&
        (attempt === null || checkpoint.attemptId === null || checkpoint.attemptId === attempt.id),
    )
    .map((checkpoint) => ({
      at: checkpoint.createdAt,
      line: { kind: "checkpoint", checkpoint, mark: CHECKPOINT_MARK[checkpoint.kind] },
    }));

const STEP_MARK: Readonly<Record<ReplyStep["state"], Mark>> = {
  running: "running",
  awaiting: "waiting",
  done: "done",
  failed: "failed",
  denied: "failed",
  unfinished: "cancelled",
  uncertain: "unresolved",
  stopped: "cancelled",
};

/**
 * The tool calls of the Attempt's own turns, at the time each started. A call that never started,
 * such as one refused before it ran, goes at the time of the call before it.
 */
const toolLines = (attempt: Attempt | null, activity: AttemptActivity | null): Array<Timed> => {
  if (attempt === null || activity === null || activity.attempt.id !== attempt.id) return [];
  let at = attempt.startedAt;
  return activity.steps.flatMap((step) => {
    if (step.kind !== "tool") return [];
    at = step.startedAt ?? at;
    return [{ at, line: { kind: "tool", step, mark: STEP_MARK[step.state] } }];
  });
};

/** The hob whose work reached `milestone`, when it is not the Task's owner. */
const reacherOf = (task: Task, milestone: Milestone): AgentId | null =>
  milestone.reachedBy === null || milestone.reachedBy === task.ownerId ? null : milestone.reachedBy;

/**
 * What happened, in order: the Task's steps and its members' Tasks, the tool calls of the chosen
 * Attempt's own turns, what its owner reported in the
 * chosen Attempt, the milestones it reached, then those still ahead, and how the Attempt ended
 * when it ended without finishing.
 */
const happenedOf = (
  tree: TaskTree,
  task: Task,
  attempt: Attempt | null,
  activity: AttemptActivity | null,
): ReadonlyArray<HappenedLine> => {
  const milestones = tree.milestones.filter((each) => each.taskId === task.id).sort((a, b) => a.position - b.position);
  const reached: Array<Timed> = milestones.flatMap((milestone) =>
    milestone.reachedAt === null
      ? []
      : [
          {
            at: milestone.reachedAt,
            line: { kind: "milestone", milestone, by: reacherOf(task, milestone), mark: "done" },
          },
        ],
  );
  // A refused call is the hub's record, not a report, so it shows whichever Attempt is chosen.
  const refused: Array<Timed> = tree.refusals
    .filter((refusal) => refusal.taskId === task.id)
    .map((refusal) => ({ at: refusal.refusedAt, line: { kind: "refused", refusal, mark: "failed" } }));
  const timed = [
    ...childLines(tree, task),
    ...toolLines(attempt, activity),
    ...reportLines(tree, task, attempt, milestones),
    ...reached,
    ...refused,
  ];
  // A stable sort keeps lines that share a time, such as steps planned together, in their order.
  const lines = timed.sort((a, b) => a.at.localeCompare(b.at)).map((each) => each.line);
  for (const milestone of milestones) {
    if (milestone.reachedAt === null) lines.push({ kind: "milestone", milestone, by: null, mark: "next" });
  }
  if (attempt !== null && ENDED_EARLY.has(attempt.state)) {
    lines.push({ kind: "ended", attempt, mark: endedMark(attempt.state) });
  }
  return lines;
};

const WAITS: ReadonlySet<TaskState> = new Set(["waiting", "blocked"]);

/** Where the Attempt shown stands, or the Task's result once it has one. */
const lineOf = (tree: TaskTree, task: Task, attempt: Attempt | null, inChat: Question | null): SummaryLine => {
  const tries = tree.attempts.filter((each) => each.taskId === task.id);
  const earlier =
    attempt === null ? 0 : tries.filter((each) => each.number < attempt.number && ENDED_EARLY.has(each.state)).length;
  if (task.result !== null) {
    const from = tries.find((each) => each.id === task.result?.attemptId);
    const other = attempt !== null && from !== undefined && from.id !== attempt.id;
    return { kind: "result", summary: task.result.summary, from: other ? from.number : null, earlier: 0 };
  }
  if (inChat !== null) return { kind: "asks", asker: inChat.askerId, earlier };
  if (attempt === null) return { kind: isTerminalTask(task.state) ? "no-result" : "not-started", earlier };
  if (ENDED_EARLY.has(attempt.state)) {
    return { kind: "ended", attempt: attempt.number, mark: endedMark(attempt.state), earlier };
  }
  if (WAITS.has(task.state)) return { kind: "waiting", attempt: attempt.number, earlier };
  if (isLiveAttempt(attempt.state)) return { kind: "working", attempt: attempt.number, earlier };
  return { kind: "no-result", earlier };
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
  const inChat = isTerminalTask(tree.tasks[0]?.state ?? task.state) ? null : questionForYou(tree, task);
  return {
    line: lineOf(tree, task, attempt, inChat),
    asked: {
      brief: delegation?.brief ?? task.brief,
      from: delegation?.leadId ?? null,
      expected: delegation?.expectedOutput ?? null,
    },
    happened: happenedOf(tree, task, attempt, activity),
    made: { artifacts, changes },
    open: {
      questions: tree.questions.filter(
        (each) => each.state === "open" && under.has(each.taskId) && each.id !== inChat?.id,
      ),
      approvals: approvals.filter((each) => approvalFor(each, task, under)),
      uncommitted: tree.checkpoints.filter((each) => each.kind === "uncommitted" && under.has(each.taskId)),
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
