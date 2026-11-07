import { ActivityRepository, GitWorkspace, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import { isTerminalTask, type Task, type TaskId } from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { PathSeparator } from "./authority.ts";

/**
 * A lead's commit of a member's open work (#742). A member commits its own Task's work, as itself:
 * a lead that commits a member's changes from its own session makes them under the lead's identity,
 * as Frodo did with Nettle's staged tree. While a Task under the lead's, owned by another hob, has
 * not ended and has changes left uncommitted in a repository, the hub holds the lead's `git commit`
 * there and says whose work it is, from its own turns and its steps' alike. Commits elsewhere run.
 */

/** Whether `folder` is `repository` or inside it. */
const within = (folder: string, repository: string, separator: PathSeparator) =>
  folder === repository || folder.startsWith(repository.endsWith(separator) ? repository : `${repository}${separator}`);

/**
 * The open Tasks another hob owns under the work `caller`'s hob does on its Task: under the highest
 * Task above it, itself included, that the same hob owns, so a step's commit is held as its owner's.
 */
const membersOpen = (tasks: ReadonlyArray<Task>, caller: Task) => {
  const byId = new Map(tasks.map((task) => [task.id as string, task]));
  const parentOf = (task: Task) => (task.parentId === null ? undefined : byId.get(task.parentId));
  let top = caller;
  for (let parent = parentOf(top); parent?.ownerId === caller.ownerId; parent = parentOf(top)) top = parent;
  const under = (task: Task): boolean => {
    const parent = parentOf(task);
    return parent !== undefined && (parent.id === top.id || under(parent));
  };
  return tasks.filter((task) => task.ownerId !== caller.ownerId && !isTerminalTask(task.state) && under(task));
};

/** What the lead is told of a commit it is held from, naming each member's Task and files. */
const heldCommitReason = (
  repository: string,
  held: ReadonlyArray<{ readonly task: TaskId; readonly hob: string; readonly paths: ReadonlyArray<string> }>,
) => {
  const whose = held.map(({ task, hob, paths }) => `${paths.join(", ")} of Task ${task}, which ${hob} works on`);
  const hobs = [...new Set(held.map(({ hob }) => hob))].join(" and ");
  return `${repository} holds changes a member has not committed: ${whose.join("; ")}. They are ${hobs}'s to commit, as ${held.length === 1 ? "itself" : "themselves"}, so Hobbots does not let you commit there while ${held.length === 1 ? "that Task is" : "those Tasks are"} open, even when one is blocked. Never commit a member's work yourself: wait for its Task to end, then commit what is your own.`;
};

/**
 * Why a commit the caller makes in the repository Git finds from `cwd`, working on `taskId`, is held,
 * or null. A hub that keeps no Workbench records or reads no Git state holds nothing.
 */
export const makeHeldCommits = (separator: PathSeparator) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const hobs = yield* HobbotsRepository;
    const activity = yield* Effect.serviceOption(ActivityRepository);
    const workspace = yield* Effect.serviceOption(GitWorkspace);
    return (taskId: TaskId | null, cwd: string): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        if (taskId === null || Option.isNone(activity) || Option.isNone(workspace)) return null;
        const own = yield* tasks.readTree(taskId);
        const caller = Option.isSome(own) ? own.value.tasks[0] : undefined;
        if (caller === undefined) return null;
        const tree = caller.parentId === null ? own : yield* tasks.readTree(caller.rootId);
        if (Option.isNone(tree)) return null;
        const open = membersOpen(tree.value.tasks, caller);
        const attempts = tree.value.attempts.filter((attempt) => open.some((task) => task.id === attempt.taskId));
        if (attempts.length === 0) return null;
        const records = yield* activity.value.readMany(attempts.map((attempt) => attempt.id));
        const held: Array<{ task: TaskId; hob: string; paths: ReadonlyArray<string> }> = [];
        let repository: string | null = null;
        for (const task of open) {
          const files = records
            .filter((record) => record.attempt.taskId === task.id)
            .flatMap((record) => record.changes)
            .flatMap((change) =>
              (change.movedFrom === null ? [change.path] : [change.path, change.movedFrom]).map((path) => ({
                folder: change.folder,
                path,
              })),
            );
          if (files.length === 0) continue;
          const left = (yield* workspace.value.uncommitted(files)).find((each) =>
            within(cwd, each.repository, separator),
          );
          if (left === undefined || left.paths.length === 0) continue;
          const hob = yield* hobs.findAgent(task.ownerId);
          repository = left.repository;
          held.push({ task: task.id, hob: Option.isSome(hob) ? hob.value.name : task.ownerId, paths: left.paths });
        }
        return repository === null ? null : heldCommitReason(repository, held);
      });
  });
