import type { Attempt, AttemptId, Task, TaskId, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Tabs } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { attemptActivityQuery } from "../../api/workbench.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { messages as roomCopy } from "../quest-room/messages.ts";
import { DockChevron } from "../quest-room/room-icons.tsx";
import type { RoomMoves, RoomView } from "../quest-room/room-search.ts";
import { DockPanel } from "./dock-panel.tsx";
import { useTerminalActivity } from "./use-terminal-activity.ts";
import { WorkbenchHeader } from "./workbench-header.tsx";
import {
  type ActivityRead,
  attemptsOf,
  chosenAttempt,
  isWorkbenchTab,
  openingAttempt,
  type ProbedRead,
  tabStates,
  WORKBENCH_TABS,
} from "./workbench-model.ts";
import { WorkbenchTabs } from "./workbench-tabs.tsx";

/**
 * The Workbench docked under the room's lanes (ADR 027, ADR 023): folded to a strip of its tabs
 * until one is picked, then open on that tab for the lit lane's Task, or the Quest's top Task with
 * none lit. Its header names the Task and picks the try every tab follows.
 */
export function WorkbenchDock({
  tree,
  taskId,
  view,
  hobs,
  moves,
}: {
  tree: TaskTree;
  taskId: TaskId;
  view: RoomView;
  hobs: HobLookup;
  moves: RoomMoves;
}) {
  const task = tree.tasks.find((each) => each.id === taskId) ?? tree.tasks[0];
  if (task === undefined) return null;
  return <Dock key={task.id} tree={tree} task={task} view={view} hobs={hobs} moves={moves} />;
}

/**
 * The Attempt the dock shows. With none chosen it opens on the latest that recorded work, reading
 * one Attempt's records at a time from the newest back: the one it shows is the one it reads, so
 * once that read finds nothing the next render moves to the one before (#386). The newer Attempts
 * it passed over stay read, so their records are not dropped from the cache and read again.
 */
const useShownAttempt = (
  tree: TaskTree,
  task: Task,
  attempts: ReadonlyArray<Attempt>,
  chosen: AttemptId | undefined,
): Attempt | null => {
  const queryClient = useQueryClient();
  const readOf = (each: Attempt): ProbedRead => {
    const state = queryClient.getQueryState(attemptActivityQuery(each.id).queryKey);
    if (state?.data !== undefined) return state.data.activity;
    return state?.status === "error" ? "failed" : "unread";
  };
  const shown = chosenAttempt(attempts, chosen, () => openingAttempt(tree, task, attempts, readOf));
  const passed = chosen === undefined && shown !== null ? attempts.filter((each) => each.number > shown.number) : [];
  useQueries({ queries: passed.map((each) => attemptActivityQuery(each.id)) });
  return shown;
};

function Dock({
  tree,
  task,
  view,
  hobs,
  moves,
}: {
  tree: TaskTree;
  task: Task;
  view: RoomView;
  hobs: HobLookup;
  moves: RoomMoves;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const attempts = attemptsOf(tree, task);
  const attempt = useShownAttempt(tree, task, attempts, view.attemptId);
  const read = useQuery({
    ...attemptActivityQuery(attempt?.id ?? ("" as AttemptId)),
    enabled: attempt !== null,
  });
  const activity: ActivityRead = attempt === null ? "none" : (read.data ?? (read.isError ? "failed" : "loading"));
  // The Terminal replays every hob's commands in the tree, so the others' count toward its label,
  // and so does each other Task that could not be read, so the Terminal stays open to say so.
  const terminal = useTerminalActivity(tree, task, attempt);
  const elsewhere =
    terminal.activities
      .filter((each) => each.attempt.id !== attempt?.id)
      .reduce((sum, each) => sum + each.commands.length, 0) + terminal.unread;
  const states = tabStates(attempt, activity, elsewhere);
  const open = view.tab !== undefined;
  const shared = {
    tree,
    task,
    attempt,
    activity: typeof activity === "object" ? activity : null,
    hobs,
    onTab: moves.tab,
  };
  return (
    <section
      aria-label={roomCopy.dock.named({ title: taskTitle(task) })}
      className={cn("flex shrink-0 flex-col border-t border-line bg-deep", open && "h-dock")}
    >
      <Tabs
        value={view.tab ?? ""}
        onValueChange={(next) => isWorkbenchTab(next) && moves.tab(next)}
        className="min-h-0 flex-1"
      >
        <div className="flex items-center gap-2 py-1 ps-4 pe-3">
          <span className="text-detail font-bold text-label">{roomCopy.dock.label}</span>
          {/* In a narrow room the tabs scroll sideways rather than push the fold button out. */}
          <div className="min-w-0 overflow-x-auto">
            <WorkbenchTabs states={states} />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="ms-auto"
            aria-expanded={open}
            aria-label={open ? roomCopy.dock.fold : roomCopy.dock.open}
            title={open ? roomCopy.dock.fold : roomCopy.dock.open}
            onClick={() => moves.tab(open ? undefined : "summary")}
          >
            <DockChevron open={open} />
          </Button>
        </div>
        {open && (
          <>
            <WorkbenchHeader
              tree={tree}
              task={task}
              attempts={attempts}
              attempt={attempt}
              read={activity}
              hobs={hobs}
              headingRef={heading}
              onAttempt={moves.attempt}
            />
            {/* Every panel stays mounted, so each keeps its scroll, selection and folds while another shows. */}
            <div className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-card border-(length:--edge) border-line bg-panel">
              {WORKBENCH_TABS.map((tab) => (
                <DockPanel
                  key={tab}
                  tab={tab}
                  on={tab === view.tab}
                  state={states[tab]}
                  owner={hobs(task.ownerId).name}
                  props={shared}
                  file={view.file}
                  onRetry={() => void read.refetch()}
                />
              ))}
            </div>
          </>
        )}
      </Tabs>
    </section>
  );
}
