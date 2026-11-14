import type { Actor } from "./actor.ts";
import type { AgentId } from "./ids.ts";
import type { TaskTree } from "./quest.ts";
import { isTerminalTask, type Task } from "./task.ts";

// An @mention of a member in a quest (#1446): your message in the lead's chat that names a member
// with `@` (found by `mentionsIn`, ADR 039) goes straight to that member's Task as your note, and the
// lead is not woken for it.

/**
 * The Task each mentioned member works on in a Quest of the chat (#1446): its highest open Task in
 * an open Quest led from this chat, one per hob. A hob with no open Task there, and the lead
 * itself, get none, so the message goes to the lead as usual.
 */
export const mentionTargets = (
  trees: ReadonlyArray<TaskTree>,
  leadId: AgentId,
  mentioned: ReadonlyArray<Actor>,
): ReadonlyArray<Task> => {
  const quests = trees.filter((tree) => {
    const root = tree.tasks[0];
    return root !== undefined && !isTerminalTask(root.state) && tree.quests.some((quest) => quest.taskId === root.id);
  });
  return mentioned.flatMap((actor) => {
    if (actor.kind !== "hob" || actor.id === leadId) return [];
    const task = quests
      .flatMap((tree) => tree.tasks)
      .find((each) => each.ownerId === actor.id && !isTerminalTask(each.state));
    return task === undefined ? [] : [task];
  });
};
