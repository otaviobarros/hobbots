import type { Task, TaskId, TaskTree } from "@hobbots/domain";

/**
 * The lane the room lights: the one the address names, else the one holding the Task a link named
 * when that is not the Quest's top Task. With none lit, the room shows everyone.
 */
export const litTask = (tree: TaskTree, named: Task, lane: TaskId | undefined): TaskId | undefined => {
  if (lane !== undefined && tree.tasks.some((task) => task.id === lane)) return lane;
  return named.id === tree.tasks[0]?.id ? undefined : named.id;
};
