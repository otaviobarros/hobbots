import { ancestorsOf, type Task, type TaskTree } from "@hobbots/domain";

/**
 * The folders a member works in (#582): those its Delegation gives it, or for a step or a Task
 * under it, those of the nearest Delegation above. Each Delegation already holds only the folders
 * its lead had, so the nearest one is the member's list. Null for work no lead gave, which works
 * in its owner's own folders.
 */
export const memberFolders = (tree: TaskTree, task: Task): ReadonlyArray<string> | null => {
  for (const each of [task, ...ancestorsOf(task, tree.tasks)]) {
    const delegation = tree.delegations.find((one) => one.childTaskId === each.id);
    if (delegation !== undefined) return delegation.authority.folders;
  }
  return null;
};

/** A folder's last name, to show it short: `/Users/you/site` is `site`. */
export const folderName = (folder: string): string => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
