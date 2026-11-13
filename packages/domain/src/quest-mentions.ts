import type { Actor } from "./actor.ts";
import type { AgentId } from "./ids.ts";
import type { TaskTree } from "./quest.ts";
import { isTerminalTask, type Task } from "./task.ts";

/**
 * An @mention of a member in a quest (#1446): your message in the lead's chat that names a member
 * with `@` goes straight to that member's Task as your note, and the lead is not woken for it.
 *
 * Only as much parsing as that needs: `@` and a name, matched whole and ignoring case. #1455 adds
 * `Message.mentions` with the hub's own parser, `mentionsIn(text, roster)`; `mentionedIn` takes the
 * same arguments and returns the same Actors, so it is the one place to swap for it.
 */

/** Someone a message can mention: who they are and the name you call them by. */
export interface Mentionable {
  readonly actor: Actor;
  readonly name: string;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Who `text` mentions with `@` and their whole name, in the roster's order. */
export const mentionedIn = (text: string, roster: ReadonlyArray<Mentionable>): ReadonlyArray<Actor> =>
  roster
    .filter((each) => {
      const name = each.name.trim();
      // Not inside an address such as you@example.com, and not the start of a longer name.
      return name !== "" && new RegExp(`(^|[^\\w@])@${escaped(name)}(?![\\w-])`, "iu").test(text);
    })
    .map((each) => each.actor);

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
