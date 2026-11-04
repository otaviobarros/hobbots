import type { Task, TaskId, TaskTree } from "@hobbots/domain";
import { useBackpack } from "../../api/backpack.ts";
import { useBlockers } from "../../api/blockers.ts";
import { useNow } from "../inbox/use-now.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { waitingCount, waitingView } from "./backpack-model.ts";
import { messages } from "./messages.ts";
import { WaitingList } from "./waiting-list.tsx";

const copy = messages;

/**
 * What the hob on one Task is waiting on, in the task sheet: "Backpack · N" with one line per item,
 * the items about its request that wait for its hob, so a lead's Task holds its members' results and
 * questions too. You can look into it; you never work it, and it never badges.
 */
export function TaskBackpack({
  tree,
  task,
  hobs,
  onOpen,
}: {
  tree: TaskTree;
  task: Task;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const now = useNow();
  const scope = {
    kind: "task",
    hobId: task.ownerId,
    taskIds: new Set<string>(tree.tasks.map((each) => each.id)),
    questIds: new Set<string>(tree.quests.map((quest) => quest.id)),
  } as const;
  const view = waitingView(useBackpack().items, useBlockers(), scope, now);
  if (waitingCount(view) + view.handled.length + view.routine === 0) return null;
  return (
    <section
      aria-label={copy.task.label({ title: taskTitle(task) })}
      className="flex flex-col gap-1 rounded-card bg-card px-1.5 pt-2 pb-2"
    >
      <h3 className="m-0 flex items-center justify-between px-2 text-detail font-bold text-label">
        {copy.task.heading}
        <span className="rounded-dot bg-line px-1.5 text-meta">{waitingCount(view)}</span>
      </h3>
      <WaitingList
        view={view}
        hobs={hobs}
        now={now}
        owners={false}
        onOpen={(item) => item.taskId !== null && item.taskId !== task.id && onOpen(item.taskId)}
        label={copy.task.list}
      />
    </section>
  );
}
