import type { Task, TaskId, TaskTree } from "@hobbots/domain";
import { Tabs } from "@hobbots/ui/components/tabs";
import { type RefObject, useRef } from "react";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { messages as roomCopy } from "../quest-room/messages.ts";
import type { RoomLane } from "../quest-room/room-model.ts";
import type { RoomMoves, RoomView } from "../quest-room/room-search.ts";
import { DockBar } from "./dock-bar.tsx";
import type { DockSource } from "./dock-model.ts";
import { DockPanel } from "./dock-panel.tsx";
import { messages } from "./messages.ts";
import { useDockHeight } from "./use-dock-height.ts";
import { useDockRead } from "./use-dock-read.ts";
import { WorkbenchHeader } from "./workbench-header.tsx";
import { attemptsOf, isWorkbenchTab, WORKBENCH_TABS } from "./workbench-model.ts";

/**
 * One Workbench for the whole Quest, docked under the lanes (ADR 027, ADR 023). Folded, it is a
 * strip of its tabs with how many records each lists; a tab or a lane slides it open, its top edge
 * drags it taller, and the chevron folds it again. Changes, Files and Terminal list every hob's work
 * in one list, or the lit lane's alone, each on the try picked for its Task. It reads the Quest's
 * tree in one call and stays live through the tree's one stream.
 */
export function WorkbenchDock({
  tree,
  lanes,
  lit,
  view,
  hobs,
  moves,
}: {
  tree: TaskTree;
  lanes: ReadonlyArray<RoomLane>;
  /** The Task whose lane is lit, or undefined while the dock shows everyone. */
  lit: TaskId | undefined;
  view: RoomView;
  hobs: HobLookup;
  moves: RoomMoves;
}) {
  const { top, lane, litTask, only, sources, states, counts, retry } = useDockRead(tree, lanes, lit, view);
  const height = useDockHeight();
  const heading = useRef<HTMLHeadingElement>(null);
  if (top === undefined) return null;
  const open = view.tab !== undefined;
  const shared = { tree, sources, hobs, onTab: moves.tab };
  return (
    <section
      aria-label={roomCopy.dock.named({ title: taskTitle(top) })}
      className="@container/dock relative flex max-h-3/4 shrink-0 flex-col border-t border-line bg-deep"
      style={open ? { height: height.height } : undefined}
    >
      {open && (
        // The window splitter pattern: a focusable edge that drags, or moves with the arrow keys.
        // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or be dragged (STD-REACT-020).
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={messages.dock.resize}
          aria-valuenow={height.height}
          tabIndex={0}
          onPointerDown={height.onPointerDown}
          onKeyDown={height.onKeyDown}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none outline-none hover:bg-line-2 focus-visible:bg-focus-ring"
        />
      )}
      <Tabs
        value={view.tab ?? ""}
        onValueChange={(next) => isWorkbenchTab(next) && moves.tab(next)}
        className="min-h-0 flex-1"
      >
        <DockBar
          states={states}
          counts={counts}
          open={open}
          filter={
            lane === undefined || only === undefined
              ? null
              : {
                  hob: hobs(lane.ownerId),
                  name: "taskId" in only && litTask !== undefined ? taskTitle(litTask) : hobs(lane.ownerId).name,
                }
          }
          party={lanes.length > 1}
          onEveryone={() => moves.lane(undefined)}
          onFold={() => moves.tab(open ? undefined : "changes")}
        />
        {open && (
          <>
            {litTask !== undefined && (
              <LitHeader tree={tree} task={litTask} sources={sources} hobs={hobs} heading={heading} moves={moves} />
            )}
            {/* Every panel stays mounted, so each keeps its scroll, selection and folds while another shows. */}
            <div className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-card border-(length:--edge) border-line bg-panel">
              {WORKBENCH_TABS.map((tab) => (
                <DockPanel
                  key={tab}
                  tab={tab}
                  on={tab === view.tab}
                  state={states[tab]}
                  props={shared}
                  file={view.file}
                  from={view.from}
                  labels={litTask === undefined}
                  onRetry={retry}
                />
              ))}
            </div>
          </>
        )}
      </Tabs>
    </section>
  );
}

/**
 * The lit lane's Task over the panels, or a Task alone's: its hob, title and byline, Live or
 * History, and the try every tab follows once it was retried.
 */
function LitHeader({
  tree,
  task,
  sources,
  hobs,
  heading,
  moves,
}: {
  tree: TaskTree;
  task: Task;
  sources: ReadonlyArray<DockSource>;
  hobs: HobLookup;
  heading: RefObject<HTMLHeadingElement | null>;
  moves: RoomMoves;
}) {
  const source = sources.find((each) => each.task.id === task.id);
  const attempts = attemptsOf(tree, task);
  return (
    <WorkbenchHeader
      tree={tree}
      task={task}
      attempts={attempts}
      attempt={source?.attempt ?? null}
      read={source?.activity ?? (attempts.length === 0 ? "none" : "loading")}
      hobs={hobs}
      headingRef={heading}
      onAttempt={moves.attempt}
    />
  );
}
