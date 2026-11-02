import type { TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import type { ReactNode } from "react";
import { useBackpack } from "../../api/backpack.ts";
import { useBlockers } from "../../api/blockers.ts";
import { useNow } from "../inbox/use-now.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { waitingCount, waitingView } from "./backpack-model.ts";
import { messages } from "./messages.ts";
import { useOpenItem } from "./use-open-item.ts";
import { WaitingList } from "./waiting-list.tsx";

const copy = messages;

/**
 * What the hobs on one request's Tasks are waiting on, in its section of the Quest tab: every item
 * about a Task or Quest of the tree, in the lead's backpack or a member's, each opening its Task.
 */
export function RoomBackpack({
  tree,
  hobs,
  onOpen,
}: {
  tree: TaskTree;
  hobs: HobLookup;
  onOpen: (taskId: TaskId) => void;
}) {
  const now = useNow();
  const scope = {
    kind: "tree",
    taskIds: new Set<string>(tree.tasks.map((task) => task.id)),
    questIds: new Set<string>(tree.quests.map((quest) => quest.id)),
  } as const;
  const view = waitingView(useBackpack().items, useBlockers(), scope, now);
  const top = tree.tasks[0];
  if (top === undefined || waitingCount(view) + view.handled.length + view.routine === 0) return null;
  return (
    <section
      aria-label={copy.quest.label({ title: taskTitle(top) })}
      className="flex flex-col gap-1 border-t-2 border-line px-1.5 pt-2 pb-2"
    >
      <h3 className="lbl m-0 px-2 text-xs text-label">{copy.quest.heading}</h3>
      <WaitingList
        view={view}
        hobs={hobs}
        now={now}
        owners
        onOpen={(item) => item.taskId !== null && onOpen(item.taskId)}
        label={copy.quest.list}
      />
    </section>
  );
}

/** Every hob's backpack, folded at the end of the Quest tab: the workspace's view of what hobs wait on. */
export function WorkspaceBackpack({ hobs }: { hobs: HobLookup }) {
  const now = useNow();
  const backpack = useBackpack();
  const view = waitingView(backpack.items, useBlockers(), { kind: "workspace" }, now);
  const openItem = useOpenItem();
  const count = waitingCount(view);
  return (
    <details aria-label={copy.workspace.label} className="border-b-4 border-line">
      <summary className="lbl cursor-pointer px-3.5 py-2.5 text-xs text-label hover:bg-hover">
        {backpack.status === "success" ? copy.workspace.heading({ count }) : copy.workspace.unknown}
      </summary>
      <WorkspaceBody
        status={backpack.status}
        retry={backpack.retry}
        empty={count + view.handled.length + view.routine === 0}
      >
        <WaitingList
          view={view}
          hobs={hobs}
          now={now}
          owners
          onOpen={(item) => void openItem(item)}
          label={copy.workspace.list}
          className="px-1.5 pb-2"
        />
      </WorkspaceBody>
    </details>
  );
}

/** The list once it is read; until then, that it is being read, or that it could not be, with Try again. */
function WorkspaceBody({
  status,
  retry,
  empty,
  children,
}: {
  status: "pending" | "error" | "success";
  retry: () => void;
  empty: boolean;
  children: ReactNode;
}) {
  if (status === "pending") return <p className="m-0 px-3.5 pb-3 text-detail text-label">{copy.workspace.loading}</p>;
  if (status === "error")
    return (
      <p role="alert" className="m-0 flex items-center gap-2 px-3.5 pb-3 text-detail text-rose">
        <span className="flex-1">{copy.workspace.loadFailed}</span>
        <Button variant="chip" size="xs" onClick={retry}>
          {copy.workspace.tryAgain}
        </Button>
      </p>
    );
  return empty ? <p className="m-0 px-3.5 pb-3 text-detail text-label">{copy.workspace.empty}</p> : children;
}
